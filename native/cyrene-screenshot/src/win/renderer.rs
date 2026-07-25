//! Overlay renderer with a GDI primary path and optional Direct2D upgrade path.
//!
//! T5c guarantees:
//! - Frozen frame is uploaded once and cached; mouse-move repaints reuse it.
//! - First presentation order is paint → `UpdateWindow` → `DwmFlush` before
//!   `overlay-visible` is emitted by the caller.
//! - Direct2D is attempted at construction; if factory creation fails we fall
//!   back to GDI for the whole session. The GDI path still honors the
//!   overlay-visible ordering above.
//!
//! Direct2D bitmap upload/paint is deferred to Task 7's device-context path;
//! when D2D init succeeds we still paint via GDI against the same cached
//! frozen DIB so the first-paint / DwmFlush contract is identical.

use windows::Win32::{
    Foundation::{COLORREF, HWND, RECT},
    Graphics::{
        Direct2D::{D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1CreateFactory, ID2D1Factory},
        Dwm::DwmFlush,
        Gdi::{
            AC_SRC_OVER, AlphaBlend, BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BLENDFUNCTION, BitBlt,
            CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreatePen,
            CreateSolidBrush, DIB_RGB_COLORS, DeleteDC, DeleteObject, FillRect, GetDC,
            GetStockObject, HBITMAP, HDC, HGDIOBJ, HPEN, NULL_BRUSH, PS_SOLID, Rectangle,
            ReleaseDC, SRCCOPY, SelectObject, UpdateWindow,
        },
    },
};

use crate::{
    error::HelperError,
    geometry::{RectI, place_toolbar},
    win::{
        capture::CpuBgraFrame,
        display::DisplayInfo,
        window::{OverlayWindow, TOOLBAR_BUTTON_GAP, TOOLBAR_GAP, TOOLBAR_HEIGHT, TOOLBAR_WIDTH},
    },
};

/// Toolbar layout computed for the current selection, in client coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolbarLayout {
    pub toolbar: RectI,
    pub confirm: RectI,
    pub cancel: RectI,
}

/// Overlay paint backend. Owns a single cached frozen-frame GDI bitmap.
///
/// `d2d_available` records whether Direct2D factory creation succeeded so
/// later tasks can upgrade the paint path without re-probing.
pub struct OverlayRenderer {
    gdi_cache: Option<GdiFrameCache>,
    /// True when a Direct2D factory was created successfully at `new()`.
    pub d2d_available: bool,
    /// Incremented each time a frozen frame is uploaded. Stays constant across
    /// mouse-move repaints.
    pub upload_count: u64,
    _d2d_factory: Option<ID2D1Factory>,
}

struct GdiFrameCache {
    width: i32,
    height: i32,
    dib: HBITMAP,
    mem_dc: HDC,
    old_obj: HGDIOBJ,
}

impl OverlayRenderer {
    pub fn new() -> Result<Self, HelperError> {
        // Prefer Direct2D; fall back silently to GDI if the factory cannot be
        // created (headless session, missing d2d1.dll, etc.).
        let d2d_factory = unsafe {
            D2D1CreateFactory::<ID2D1Factory>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None).ok()
        };
        Ok(Self {
            gdi_cache: None,
            d2d_available: d2d_factory.is_some(),
            upload_count: 0,
            _d2d_factory: d2d_factory,
        })
    }

    /// Ensure any size-dependent resources match `display`. For the GDI cache
    /// this is a no-op until the next upload; kept for API stability.
    pub fn resize(&mut self, _hwnd: HWND, _display: &DisplayInfo) -> Result<(), HelperError> {
        Ok(())
    }

    /// Upload the frozen frame once. Subsequent paints reuse the cache and
    /// never re-capture or re-upload.
    pub fn upload_frozen(&mut self, frame: &CpuBgraFrame) -> Result<(), HelperError> {
        self.clear_gdi_cache();
        self.gdi_cache = Some(create_gdi_frame_cache(frame)?);
        self.upload_count = self.upload_count.saturating_add(1);
        Ok(())
    }

    pub fn clear_frozen(&mut self) {
        self.clear_gdi_cache();
    }

    /// Paint dimmed frozen background, selection border, and optional toolbar.
    pub fn paint(
        &mut self,
        hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
    ) -> Result<(), HelperError> {
        let hdc = unsafe { GetDC(Some(hwnd)) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        let result = paint_gdi_on_hdc(hdc, self.gdi_cache.as_ref(), selection, display, toolbar);
        let _ = unsafe { ReleaseDC(Some(hwnd), hdc) };
        result
    }

    /// Paint using a caller-provided HDC (WM_PAINT path).
    pub fn paint_on_hdc(
        &mut self,
        hdc: HDC,
        _hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
    ) -> Result<(), HelperError> {
        paint_gdi_on_hdc(hdc, self.gdi_cache.as_ref(), selection, display, toolbar)
    }

    /// `DwmFlush` so the compositor has presented the first frame before
    /// `overlay-visible` is emitted.
    pub fn flush(&self) -> Result<(), HelperError> {
        // SAFETY: DwmFlush has no parameters; it synchronizes with DWM.
        unsafe { DwmFlush() }.map_err(HelperError::from)
    }

    fn clear_gdi_cache(&mut self) {
        if let Some(cache) = self.gdi_cache.take() {
            // SAFETY: restore previous object then free owned DC/bitmap.
            unsafe {
                let _ = SelectObject(cache.mem_dc, cache.old_obj);
                let _ = DeleteObject(HGDIOBJ(cache.dib.0));
                let _ = DeleteDC(cache.mem_dc);
            }
        }
    }
}

impl Drop for OverlayRenderer {
    fn drop(&mut self) {
        self.clear_frozen();
    }
}

/// Compute confirm/cancel toolbar placement for a selection inside `display`.
pub fn compute_toolbar(selection: RectI, display: &DisplayInfo) -> Option<ToolbarLayout> {
    // place_toolbar expects display-relative bounds; selection in the overlay is
    // client-local (origin at display top-left), so shift display bounds to (0,0).
    let local_display = RectI {
        x: 0,
        y: 0,
        width: display.bounds.width,
        height: display.bounds.height,
    };
    let toolbar = place_toolbar(
        selection,
        local_display,
        TOOLBAR_WIDTH,
        TOOLBAR_HEIGHT,
        TOOLBAR_GAP,
    )?;
    let button_width = (toolbar.width.saturating_sub(TOOLBAR_BUTTON_GAP)) / 2;
    if button_width == 0 {
        return None;
    }
    let confirm = RectI {
        x: toolbar.x,
        y: toolbar.y,
        width: button_width,
        height: toolbar.height,
    };
    let cancel = RectI {
        x: toolbar
            .x
            .saturating_add_unsigned(button_width + TOOLBAR_BUTTON_GAP),
        y: toolbar.y,
        width: button_width,
        height: toolbar.height,
    };
    Some(ToolbarLayout {
        toolbar,
        confirm,
        cancel,
    })
}

/// First-paint helper used by the start sequence:
/// (ShowWindow already done) → paint → UpdateWindow → DwmFlush.
pub fn present_first_frame(
    renderer: &mut OverlayRenderer,
    overlay: &OverlayWindow,
    selection: Option<RectI>,
    display: &DisplayInfo,
    toolbar: Option<ToolbarLayout>,
) -> Result<(), HelperError> {
    renderer.resize(overlay.hwnd(), display)?;
    renderer.paint(overlay.hwnd(), selection, display, toolbar)?;
    // SAFETY: UpdateWindow forces a synchronous WM_PAINT for the shown window.
    let _ = unsafe { UpdateWindow(overlay.hwnd()) };
    renderer.flush()?;
    Ok(())
}

// ---- timing helpers (QPC) ---------------------------------------------------

/// Capture `QueryPerformanceCounter` ticks.
pub fn qpc_now() -> i64 {
    let mut counter = 0i64;
    // SAFETY: counter points to writable aligned storage.
    let _ = unsafe { windows::Win32::System::Performance::QueryPerformanceCounter(&mut counter) };
    counter
}

/// Elapsed whole milliseconds between two QPC samples. Returns 0 on clock
/// regression or missing frequency.
pub fn qpc_elapsed_ms(start: i64, end: i64) -> u64 {
    let mut freq = 0i64;
    // SAFETY: freq points to writable aligned storage.
    let ok = unsafe { windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq) };
    if ok.is_err() || freq <= 0 || end <= start {
        return 0;
    }
    let delta = (end as u128).saturating_sub(start as u128);
    ((delta.saturating_mul(1000)) / (freq as u128)) as u64
}

// ---- GDI helpers ------------------------------------------------------------

fn create_gdi_frame_cache(frame: &CpuBgraFrame) -> Result<GdiFrameCache, HelperError> {
    let width = i32::try_from(frame.width)
        .map_err(|_| HelperError::InvalidDisplay("frame width does not fit i32".into()))?;
    let height = i32::try_from(frame.height)
        .map_err(|_| HelperError::InvalidDisplay("frame height does not fit i32".into()))?;

    // SAFETY: desktop DC acquisition for creating a compatible DIB.
    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    // SAFETY: screen_dc is valid.
    let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.is_invalid() {
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(windows::core::Error::from_thread().into());
    }

    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: info describes a 32-bit top-down DIB; bits receives the section pointer.
    let dib = unsafe { CreateDIBSection(Some(mem_dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
    if dib.is_err() || bits.is_null() {
        let _ = unsafe { DeleteDC(mem_dc) };
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(dib
            .err()
            .unwrap_or_else(windows::core::Error::from_thread)
            .into());
    }
    let dib = dib.unwrap();

    // Copy pixels. Pitch may exceed width*4; copy row by row.
    let dst_pitch = (frame.width * 4) as usize;
    let src_pitch = frame.pitch as usize;
    // SAFETY: bits points at biWidth*abs(biHeight)*4 writable bytes.
    unsafe {
        for y in 0..frame.height as usize {
            let src = frame.pixels.as_ptr().add(y * src_pitch);
            let dst = (bits as *mut u8).add(y * dst_pitch);
            std::ptr::copy_nonoverlapping(src, dst, dst_pitch.min(src_pitch));
        }
    }

    // SAFETY: select DIB into mem_dc for subsequent BitBlt source use.
    let old_obj = unsafe { SelectObject(mem_dc, HGDIOBJ(dib.0)) };
    let _ = unsafe { ReleaseDC(None, screen_dc) };

    Ok(GdiFrameCache {
        width,
        height,
        dib,
        mem_dc,
        old_obj,
    })
}

fn paint_gdi_on_hdc(
    hdc: HDC,
    cache: Option<&GdiFrameCache>,
    selection: Option<RectI>,
    display: &DisplayInfo,
    toolbar: Option<ToolbarLayout>,
) -> Result<(), HelperError> {
    let width = i32::try_from(display.bounds.width)
        .map_err(|_| HelperError::InvalidDisplay("paint width does not fit i32".into()))?;
    let height = i32::try_from(display.bounds.height)
        .map_err(|_| HelperError::InvalidDisplay("paint height does not fit i32".into()))?;
    let bounds = RECT {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
    };

    if let Some(cache) = cache {
        // SAFETY: cache.mem_dc has the frozen DIB selected.
        unsafe {
            let _ = BitBlt(
                hdc,
                0,
                0,
                cache.width,
                cache.height,
                Some(cache.mem_dc),
                0,
                0,
                SRCCOPY,
            );
        }
        // Dim overlay via AlphaBlend of a solid black bitmap.
        alpha_dim(hdc, width, height, selection)?;
        if let Some(sel) = selection {
            // Restore undimmed selection region from the frozen cache.
            unsafe {
                let _ = BitBlt(
                    hdc,
                    sel.x,
                    sel.y,
                    i32::try_from(sel.width).unwrap_or(0),
                    i32::try_from(sel.height).unwrap_or(0),
                    Some(cache.mem_dc),
                    sel.x,
                    sel.y,
                    SRCCOPY,
                );
            }
            draw_selection_border(hdc, sel)?;
        }
    } else {
        // No frozen frame yet: solid dim fill (pre-upload path).
        let brush = unsafe { CreateSolidBrush(COLORREF(0x00303030)) };
        if brush.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        unsafe {
            FillRect(hdc, &bounds, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
        if let Some(sel) = selection {
            draw_selection_border(hdc, sel)?;
        }
    }

    if let Some(layout) = toolbar {
        draw_toolbar_gdi(hdc, layout)?;
    }
    Ok(())
}

fn alpha_dim(
    hdc: HDC,
    width: i32,
    height: i32,
    selection: Option<RectI>,
) -> Result<(), HelperError> {
    // Create a 1x1 black DIB and AlphaBlend it stretched. When a selection is
    // present we dim the four surrounding rects so the selection stays bright.
    // SAFETY: desktop DC for compatible resources.
    let screen_dc = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.is_invalid() {
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(windows::core::Error::from_thread().into());
    }
    let bmp = unsafe { CreateCompatibleBitmap(screen_dc, 1, 1) };
    if bmp.is_invalid() {
        let _ = unsafe { DeleteDC(mem_dc) };
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(windows::core::Error::from_thread().into());
    }
    let old = unsafe { SelectObject(mem_dc, HGDIOBJ(bmp.0)) };
    let brush = unsafe { CreateSolidBrush(COLORREF(0x00000000)) };
    if !brush.is_invalid() {
        let r = RECT {
            left: 0,
            top: 0,
            right: 1,
            bottom: 1,
        };
        unsafe {
            FillRect(mem_dc, &r, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
    }
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 115, // ~45% black
        AlphaFormat: 0,
    };

    let dim_rect = |hdc: HDC, x: i32, y: i32, w: i32, h: i32| {
        if w <= 0 || h <= 0 {
            return;
        }
        // SAFETY: mem_dc holds a 1x1 black bitmap; AlphaBlend stretches it.
        let _ = unsafe { AlphaBlend(hdc, x, y, w, h, mem_dc, 0, 0, 1, 1, blend) };
    };

    if let Some(sel) = selection {
        let sx = sel.x;
        let sy = sel.y;
        let sw = i32::try_from(sel.width).unwrap_or(0);
        let sh = i32::try_from(sel.height).unwrap_or(0);
        dim_rect(hdc, 0, 0, width, sy);
        dim_rect(hdc, 0, sy + sh, width, height - (sy + sh));
        dim_rect(hdc, 0, sy, sx, sh);
        dim_rect(hdc, sx + sw, sy, width - (sx + sw), sh);
    } else {
        dim_rect(hdc, 0, 0, width, height);
    }

    unsafe {
        let _ = SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem_dc);
        let _ = ReleaseDC(None, screen_dc);
    }
    Ok(())
}

fn draw_selection_border(hdc: HDC, rect: RectI) -> Result<(), HelperError> {
    // SAFETY: GDI pen/brush selection for a simple rectangle outline.
    let pen: HPEN = unsafe { CreatePen(PS_SOLID, 2, COLORREF(0x0000ffff)) };
    if pen.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let old_pen = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
    let null_brush = unsafe { GetStockObject(NULL_BRUSH) };
    let old_brush = unsafe { SelectObject(hdc, null_brush) };
    unsafe {
        let _ = Rectangle(
            hdc,
            rect.x,
            rect.y,
            rect.x.saturating_add_unsigned(rect.width),
            rect.y.saturating_add_unsigned(rect.height),
        );
        let _ = SelectObject(hdc, old_brush);
        let _ = SelectObject(hdc, old_pen);
        let _ = DeleteObject(HGDIOBJ(pen.0));
    }
    Ok(())
}

fn draw_toolbar_gdi(hdc: HDC, layout: ToolbarLayout) -> Result<(), HelperError> {
    let fill = |hdc: HDC, rect: RectI, color: u32| {
        let brush = unsafe { CreateSolidBrush(COLORREF(color)) };
        if brush.is_invalid() {
            return;
        }
        let r = RECT {
            left: rect.x,
            top: rect.y,
            right: rect.x.saturating_add_unsigned(rect.width),
            bottom: rect.y.saturating_add_unsigned(rect.height),
        };
        unsafe {
            FillRect(hdc, &r, brush);
            let _ = DeleteObject(HGDIOBJ(brush.0));
        }
    };
    fill(hdc, layout.toolbar, 0x00202024);
    fill(hdc, layout.confirm, 0x0035a555);
    fill(hdc, layout.cancel, 0x003535a5); // BGR: reddish
    Ok(())
}

/// Residual paint entry used when no renderer is attached (should be rare).
pub(crate) fn paint_hdc(
    hdc: HDC,
    selection: Option<RectI>,
    display: &DisplayInfo,
) -> Result<(), HelperError> {
    paint_gdi_on_hdc(hdc, None, selection, display, None)
}
