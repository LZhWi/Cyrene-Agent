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
                WM_CAPTURECHANGED, WM_COMMAND, WM_CREATE, WM_DESTROY, WM_KEYDOWN, WM_LBUTTONDBLCLK,
                WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_PAINT, WNDCLASSW,
                WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
            },
        },
    },
    core::{Error as WindowsError, PCWSTR, w},
};

use crate::{error::HelperError, geometry::RectI, win::display::DisplayInfo};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotOverlayWindow");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayAction {
    Selected,
    Commit,
    Cancel,
}

#[derive(Debug, Clone, Copy)]
enum InputState {
    Idle,
    Dragging { anchor: POINT },
    Selected,
}

struct WindowState {
    display_bounds: RectI,
    selection: Option<RectI>,
    input: InputState,
    action: Option<OverlayAction>,
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
            selection: None,
            input: InputState::Idle,
            action: None,
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
        state.input = InputState::Idle;
        state.action = None;
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
        unsafe { self.state.as_ref() }.borrow_mut().display_bounds = display.bounds;
        Ok(())
    }

    pub fn is_visible(&self) -> bool {
        unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(self.hwnd).as_bool() }
    }

    pub fn take_action(&self) -> Option<OverlayAction> {
        unsafe { self.state.as_ref() }.borrow_mut().action.take()
    }

    pub fn selection(&self) -> Option<RectI> {
        unsafe { self.state.as_ref() }.borrow().selection
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
            let point = point_from_lparam(lparam);
            let mut state = unsafe { &*raw }.borrow_mut();
            let point = clamp_client_point(hwnd, point);
            state.selection = None;
            state.input = InputState::Dragging { anchor: point };
            unsafe { SetCapture(hwnd) };
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let mut state = unsafe { &*raw }.borrow_mut();
            if let InputState::Dragging { anchor } = state.input {
                state.selection =
                    normalized_rect(anchor, clamp_client_point(hwnd, point_from_lparam(lparam)));
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
                    state.input = if selection.is_some() {
                        InputState::Selected
                    } else {
                        InputState::Idle
                    };
                    selected = selection.is_some();
                    if selected {
                        state.action = Some(OverlayAction::Selected);
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
            if command == 1 && state.selection.is_some() {
                state.action = Some(OverlayAction::Commit);
            } else if command == 2 {
                state.action = Some(OverlayAction::Cancel);
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
            let state = unsafe { &*raw }.borrow();
            let display = DisplayInfo {
                bounds: state.display_bounds,
                dpi: 96.0,
                rotation: crate::geometry::DisplayRotation::Identity,
                is_primary: true,
            };
            let _ = crate::win::renderer::paint_hdc(hdc, state.selection, &display);
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
        && i64::from(point.x) <= i64::from(rect.x) + i64::from(rect.width)
        && i64::from(point.y) <= i64::from(rect.y) + i64::from(rect.height)
}
