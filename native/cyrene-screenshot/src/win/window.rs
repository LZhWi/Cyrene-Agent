//! Native Win32 overlay window and input state machine.

use std::{cell::RefCell, ptr::NonNull};

use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Gdi::{BeginPaint, EndPaint, InvalidateRect, PAINTSTRUCT},
        UI::{
            Input::KeyboardAndMouse::{ReleaseCapture, SetCapture, SetFocus, VK_ESCAPE, VK_RETURN},
            WindowsAndMessaging::{
                CREATESTRUCTW, CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow,
                GWLP_USERDATA, GetClientRect, GetWindowLongPtrW, IDC_CROSS, LoadCursorW,
                RegisterClassW, SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOOWNERZORDER,
                SetForegroundWindow, SetWindowLongPtrW, SetWindowPos, ShowWindow, UnregisterClassW,
                WM_CAPTURECHANGED, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_DISPLAYCHANGE,
                WM_DPICHANGED, WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
                WM_MOUSEMOVE, WM_NCDESTROY, WM_PAINT, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
                WS_POPUP,
            },
        },
    },
    core::{Error as WindowsError, PCWSTR, w},
};

use crate::{
    error::HelperError,
    geometry::RectI,
    win::{
        display::DisplayInfo,
        renderer::{OverlayRenderer, ToolbarLayout, compute_toolbar},
    },
};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotOverlayWindow");

/// Confirm button id reserved for `WM_COMMAND` (T5b).
pub const CMD_CONFIRM: usize = 1;
/// Cancel button id reserved for `WM_COMMAND` (T5b).
pub const CMD_CANCEL: usize = 2;

pub const TOOLBAR_WIDTH: u32 = 160;
pub const TOOLBAR_HEIGHT: u32 = 36;
pub const TOOLBAR_GAP: u32 = 8;
pub const TOOLBAR_BUTTON_GAP: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAction {
    Selected,
    Commit,
    Cancel,
    /// Display topology or DPI changed while the overlay was active.
    DisplayChanged,
}

#[derive(Debug, Clone, Copy)]
enum InputState {
    Idle,
    Dragging { anchor: POINT },
    Selected,
}

struct WindowState {
    display_bounds: RectI,
    display_dpi: f32,
    selection: Option<RectI>,
    toolbar: Option<ToolbarLayout>,
    input: InputState,
    action: Option<OverlayAction>,
    /// Synchronous WM_PAINT failure captured for `present_first_frame`.
    /// Storing text avoids requiring the Win32/COM error types to be Clone.
    paint_error: Option<String>,
    /// Non-owning pointer to the active [`OverlayRenderer`]. Set by
    /// [`OverlayWindow::attach_renderer`] for the duration of a capture and
    /// cleared on hide. Used by WM_PAINT / mouse-move repaints so the frozen
    /// frame cache is reused without re-upload.
    renderer: Option<NonNull<OverlayRenderer>>,
}

pub struct OverlayWindow {
    hwnd: HWND,
    state: NonNull<RefCell<WindowState>>,
}

impl OverlayWindow {
    pub fn create(display: &DisplayInfo) -> Result<Self, HelperError> {
        let cursor = unsafe { LoadCursorW(None, IDC_CROSS) }?;
        let window_class = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            hCursor: cursor,
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        if unsafe { RegisterClassW(&window_class) } == 0 {
            let error = WindowsError::from_thread();
            if error.code().0 != 0x8007_0582u32 as i32 {
                return Err(error.into());
            }
        }

        let state = Box::new(RefCell::new(WindowState {
            display_bounds: display.bounds,
            display_dpi: display.dpi,
            selection: None,
            toolbar: None,
            input: InputState::Idle,
            action: None,
            paint_error: None,
            renderer: None,
        }));
        let state = NonNull::new(Box::into_raw(state)).expect("Box pointer is never null");
        let bounds = display.bounds;
        let hwnd = unsafe {
            CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                WINDOW_CLASS,
                w!(""),
                WS_POPUP,
                bounds.x,
                bounds.y,
                i32::try_from(bounds.width).map_err(|_| {
                    HelperError::InvalidDisplay("overlay width does not fit in i32".into())
                })?,
                i32::try_from(bounds.height).map_err(|_| {
                    HelperError::InvalidDisplay("overlay height does not fit in i32".into())
                })?,
                None,
                None,
                None,
                Some(state.as_ptr().cast()),
            )
        };
        match hwnd {
            Ok(hwnd) => Ok(Self { hwnd, state }),
            Err(error) => {
                unsafe { drop(Box::from_raw(state.as_ptr())) };
                let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
                Err(error.into())
            }
        }
    }

    /// Bind a live [`OverlayRenderer`] for paint callbacks. The pointer must
    /// remain valid until [`Self::detach_renderer`] or [`Self::hide`].
    pub fn attach_renderer(&self, renderer: &mut OverlayRenderer) {
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.paint_error = None;
        state.renderer = NonNull::new(renderer as *mut OverlayRenderer);
    }

    pub fn detach_renderer(&self) {
        unsafe { self.state.as_ref() }.borrow_mut().renderer = None;
    }

    pub fn show(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        self.set_fullscreen_bounds(display)?;
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            let _ = SetForegroundWindow(self.hwnd);
            let _ = SetFocus(Some(self.hwnd));
        }
        Ok(())
    }

    pub fn hide(&self) -> Result<(), HelperError> {
        let _ = unsafe { ShowWindow(self.hwnd, SW_HIDE) };
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.selection = None;
        state.toolbar = None;
        state.input = InputState::Idle;
        state.action = None;
        state.paint_error = None;
        state.renderer = None;
        Ok(())
    }

    pub fn set_fullscreen_bounds(&self, display: &DisplayInfo) -> Result<(), HelperError> {
        let width = i32::try_from(display.bounds.width)
            .map_err(|_| HelperError::InvalidDisplay("overlay width does not fit in i32".into()))?;
        let height = i32::try_from(display.bounds.height).map_err(|_| {
            HelperError::InvalidDisplay("overlay height does not fit in i32".into())
        })?;
        unsafe {
            SetWindowPos(
                self.hwnd,
                Some(HWND_TOPMOST),
                display.bounds.x,
                display.bounds.y,
                width,
                height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )?;
        }
        let mut state = unsafe { self.state.as_ref() }.borrow_mut();
        state.display_bounds = display.bounds;
        state.display_dpi = display.dpi;
        Ok(())
    }

    pub fn is_visible(&self) -> bool {
        unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(self.hwnd).as_bool() }
    }

    pub fn take_action(&self) -> Option<OverlayAction> {
        unsafe { self.state.as_ref() }.borrow_mut().action.take()
    }

    pub fn take_paint_error(&self) -> Option<HelperError> {
        unsafe { self.state.as_ref() }
            .borrow_mut()
            .paint_error
            .take()
            .map(HelperError::CaptureFailed)
    }

    pub fn selection(&self) -> Option<RectI> {
        unsafe { self.state.as_ref() }.borrow().selection
    }

    pub fn toolbar(&self) -> Option<ToolbarLayout> {
        unsafe { self.state.as_ref() }.borrow().toolbar
    }

    pub fn hwnd(&self) -> HWND {
        self.hwnd
    }
}

impl Drop for OverlayWindow {
    fn drop(&mut self) {
        let _ = unsafe { DestroyWindow(self.hwnd) };
        unsafe { drop(Box::from_raw(self.state.as_ptr())) };
        let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
    }
}

const HWND_TOPMOST: HWND = HWND(-1isize as *mut _);

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_CREATE {
        let create = unsafe { &*(lparam.0 as *const CREATESTRUCTW) };
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize) };
        return LRESULT(0);
    }

    let raw = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } as *mut RefCell<WindowState>;
    if raw.is_null() {
        return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
    }

    match message {
        WM_LBUTTONDOWN => {
            let point = clamp_client_point(hwnd, point_from_lparam(lparam));
            let mut state = unsafe { &*raw }.borrow_mut();
            // Hit-test toolbar buttons when a selection is already active.
            if matches!(state.input, InputState::Selected)
                && let Some(toolbar) = state.toolbar
            {
                if contains(toolbar.confirm, point) {
                    state.action = Some(OverlayAction::Commit);
                    return LRESULT(0);
                }
                if contains(toolbar.cancel, point) {
                    state.action = Some(OverlayAction::Cancel);
                    return LRESULT(0);
                }
            }
            state.selection = None;
            state.toolbar = None;
            state.input = InputState::Dragging { anchor: point };
            drop(state);
            // SetCapture may synchronously deliver WM_CAPTURECHANGED. Release
            // the RefCell borrow first so that reentrant message can mutate
            // WindowState without panicking across the extern "system" frame.
            unsafe { SetCapture(hwnd) };
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if let InputState::Dragging { anchor } = state.input {
                state.selection =
                    normalized_rect(anchor, clamp_client_point(hwnd, point_from_lparam(lparam)));
                state.toolbar = None;
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let selected = {
                let mut state = unsafe { &*raw }.borrow_mut();
                let mut selected = false;
                if let InputState::Dragging { anchor } = state.input {
                    let selection = normalized_rect(
                        anchor,
                        clamp_client_point(hwnd, point_from_lparam(lparam)),
                    )
                    .filter(|rect| rect.width >= 4 && rect.height >= 4);
                    state.selection = selection;
                    if let Some(sel) = selection {
                        let display = DisplayInfo {
                            bounds: state.display_bounds,
                            dpi: state.display_dpi,
                            rotation: crate::geometry::DisplayRotation::Identity,
                            is_primary: true,
                        };
                        state.toolbar = compute_toolbar(sel, &display);
                        state.input = InputState::Selected;
                        state.action = Some(OverlayAction::Selected);
                        selected = true;
                    } else {
                        state.toolbar = None;
                        state.input = InputState::Idle;
                    }
                }
                selected
            };
            let _ = unsafe { ReleaseCapture() };
            if selected {
                let _ = unsafe { InvalidateRect(Some(hwnd), None, false) };
            }
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if state
                .selection
                .is_some_and(|rect| contains(rect, point_from_lparam(lparam)))
            {
                state.action = Some(OverlayAction::Commit);
            }
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == VK_ESCAPE.0 as usize => {
            unsafe { &*raw }.borrow_mut().action = Some(OverlayAction::Cancel);
            LRESULT(0)
        }
        WM_KEYDOWN if wparam.0 == VK_RETURN.0 as usize => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if state.selection.is_some() {
                state.action = Some(OverlayAction::Commit);
            }
            LRESULT(0)
        }
        WM_COMMAND => {
            let command = wparam.0 & 0xffff;
            let mut state = unsafe { &*raw }.borrow_mut();
            if command == CMD_CONFIRM && state.selection.is_some() {
                state.action = Some(OverlayAction::Commit);
            } else if command == CMD_CANCEL {
                state.action = Some(OverlayAction::Cancel);
            }
            LRESULT(0)
        }
        WM_DISPLAYCHANGE | WM_DPICHANGED => {
            // Surface when the overlay is visible so an active capture aborts.
            // The app layer only acts if `active` is Some, so a broadcast while
            // the window is hidden is a no-op after take_action.
            if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd).as_bool() } {
                unsafe { &*raw }.borrow_mut().action = Some(OverlayAction::DisplayChanged);
            }
            LRESULT(0)
        }
        WM_CAPTURECHANGED => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if matches!(state.input, InputState::Dragging { .. }) {
                state.input = InputState::Idle;
            }
            LRESULT(0)
        }
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
            {
                let mut state = unsafe { &*raw }.borrow_mut();
                let display = DisplayInfo {
                    bounds: state.display_bounds,
                    dpi: state.display_dpi,
                    rotation: crate::geometry::DisplayRotation::Identity,
                    is_primary: true,
                };
                if let Some(renderer_ptr) = state.renderer {
                    // SAFETY: attach_renderer guarantees the renderer outlives
                    // the attached period; hide/detach clear this pointer first.
                    // Shared borrow only: paint_on_hdc reads the frozen cache and
                    // does not mutate OverlayRenderer, so this is safe even if a
                    // caller briefly holds &OverlayRenderer on the same thread
                    // (present_first_frame intentionally holds none across UpdateWindow).
                    let renderer = unsafe { &*renderer_ptr.as_ptr() };
                    if let Err(error) =
                        renderer.paint_on_hdc(hdc, hwnd, state.selection, &display, state.toolbar)
                    {
                        eprintln!("cyrene-screenshot: overlay paint failed: {error}");
                        state.paint_error = Some(error.to_string());
                    }
                } else {
                    let _ = crate::win::renderer::paint_hdc(hdc, state.selection, &display);
                }
            }
            let _ = unsafe { EndPaint(hwnd, &paint) };
            LRESULT(0)
        }
        WM_NCDESTROY | WM_DESTROY => {
            unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) };
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn point_from_lparam(lparam: LPARAM) -> POINT {
    POINT {
        x: (lparam.0 as u16) as i16 as i32,
        y: ((lparam.0 as u32 >> 16) as u16) as i16 as i32,
    }
}

fn clamp_client_point(hwnd: HWND, point: POINT) -> POINT {
    let mut client = RECT::default();
    let _ = unsafe { GetClientRect(hwnd, &mut client) };
    POINT {
        x: point.x.clamp(client.left, client.right),
        y: point.y.clamp(client.top, client.bottom),
    }
}

fn normalized_rect(a: POINT, b: POINT) -> Option<RectI> {
    let left = a.x.min(b.x);
    let top = a.y.min(b.y);
    let width = u32::try_from((i64::from(a.x) - i64::from(b.x)).abs()).ok()?;
    let height = u32::try_from((i64::from(a.y) - i64::from(b.y)).abs()).ok()?;
    Some(RectI {
        x: left,
        y: top,
        width,
        height,
    })
}

fn contains(rect: RectI, point: POINT) -> bool {
    i64::from(point.x) >= i64::from(rect.x)
        && i64::from(point.y) >= i64::from(rect.y)
        && i64::from(point.x) < i64::from(rect.x) + i64::from(rect.width)
        && i64::from(point.y) < i64::from(rect.y) + i64::from(rect.height)
}
