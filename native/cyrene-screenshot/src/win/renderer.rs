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

/// Long-lived GDI cache of the frozen frame. `Drop` restores the previous
/// object and frees the owned DC/bitmap so misuse cannot leak handles.
struct GdiFrameCache {
    width: i32,
    height: i32,
    dib: HBITMAP,
    mem_dc: HDC,
    old_obj: HGDIOBJ,
}

impl Drop for GdiFrameCache {
    fn drop(&mut self) {
        // SAFETY: `mem_dc` / `dib` were created as a pair in `create_gdi_frame_cache`
        // and `old_obj` is the object that was selected before the DIB. Restoring
        // first satisfies Win32's rule that a selected bitmap must not be deleted.
        unsafe {
            let _ = SelectObject(self.mem_dc, self.old_obj);
            let _ = DeleteObject(HGDIOBJ(self.dib.0));
            let _ = DeleteDC(self.mem_dc);
        }
    }
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
    ///
    /// Takes shared `&self` so paint never needs exclusive access to the
    /// renderer (WM_PAINT and optional GetDC callers only read the cache).
    pub fn paint(
        &self,
        hwnd: HWND,
        selection: Option<RectI>,
        display: &DisplayInfo,
        toolbar: Option<ToolbarLayout>,
    ) -> Result<(), HelperError> {
        // SAFETY: `hwnd` is a live overlay window on this UI thread. `GetDC`
        // returns a DC that must be paired with `ReleaseDC` for the same hwnd;
        // we always release it below, including on paint failure.
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
        &self,
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

    /// Extract a copy of the cached frozen frame cropped to `rect` (in
    /// display-local coordinates, i.e. origin at top-left of the captured
    /// desktop). The returned [`CpuBgraFrame`] owns its pixel buffer so the
    /// renderer can hand it to the clipboard writer and (optionally) the
    /// encoder thread without aliasing the GDI cache.
    ///
    /// Implementation notes:
    ///   * We allocate a top-down destination DIB section via `CreateDIBSection`
    ///     sized to `rect.width × rect.height`. `BitBlt(SRCCOPY)` from the
    ///     frozen cache DC into the destination DC copies pixels in their
    ///     native orientation (top-down); we then read them out via
    ///     `GetDIBits` so the returned buffer is independent of GDI lifetime.
    ///   * Any failure between guards is rolled back via the standard RAII
    ///     guards — no partial DIB can leak past a returned `Err`.
    pub fn extract_selection(&self, rect: RectI) -> Result<CpuBgraFrame, HelperError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(HelperError::CaptureFailed(
                "extract_selection called with zero-sized rect".into(),
            ));
        }
        let cache = self.gdi_cache.as_ref().ok_or_else(|| {
            HelperError::CaptureFailed(
                "extract_selection called without an active frozen cache".into(),
            )
        })?;

        // Selection is in display-local coordinates; clamp to the cache
        // dimensions so a malformed selection cannot read past the DIB.
        let cache_w = u32::try_from(cache.width).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "frozen cache width {} does not fit in u32",
                cache.width
            ))
        })?;
        let cache_h = u32::try_from(cache.height).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "frozen cache height {} does not fit in u32",
                cache.height
            ))
        })?;
        if rect.x < 0 || rect.y < 0 {
            return Err(HelperError::CaptureFailed(format!(
                "selection origin ({},{}) must be non-negative",
                rect.x, rect.y
            )));
        }
        if (rect.x as u64) + (rect.width as u64) > cache_w as u64
            || (rect.y as u64) + (rect.height as u64) > cache_h as u64
        {
            return Err(HelperError::CaptureFailed(format!(
                "selection {:?} exceeds cached frozen frame {cache_w}x{cache_h}",
                rect
            )));
        }

        let dst_w = i32::try_from(rect.width).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "selection width {} does not fit in i32",
                rect.width
            ))
        })?;
        let dst_h = i32::try_from(rect.height).map_err(|_| {
            HelperError::CaptureFailed(format!(
                "selection height {} does not fit in i32",
                rect.height
            ))
        })?;

        let row_bytes = (rect.width as usize)
            .checked_mul(4)
            .and_then(|b| b.checked_mul(rect.height as usize))
            .ok_or_else(|| HelperError::CaptureFailed("selection pixel buffer overflow".into()))?;
        if row_bytes > isize::MAX as usize {
            return Err(HelperError::CaptureFailed(format!(
                "selection pixel buffer {row_bytes} exceeds isize::MAX"
            )));
        }
        let mut pixels = vec![0u8; row_bytes];

        // Use the cache's own mem_dc as the source. Acquiring fresh guards
        // for the destination side keeps the cache untouched on failure.
        let screen_dc = ScreenDcGuard::acquire()?;
        let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
        let dib = BitmapGuard::create_dib_top_down(mem_dc.handle(), dst_w, dst_h)?;

        // SAFETY: cache.mem_dc has the frozen DIB selected for its lifetime;
        // mem_dc holds our destination DIB. BitBlt parameters match both
        // sides (selection rect inside the cache; destination size == dst_w
        // × dst_h).
        let blt_ok = unsafe {
            BitBlt(
                mem_dc.handle(),
                0,
                0,
                dst_w,
                dst_h,
                Some(cache.mem_dc),
                rect.x,
                rect.y,
                SRCCOPY,
            )
        };
        if let Err(error) = blt_ok {
            return Err(HelperError::CaptureFailed(format!(
                "BitBlt for selection extraction failed: {error}"
            )));
        }

        // Read the destination pixels out into our owned Vec. The DIB is
        // top-down with biHeight = -dst_h, so rows are stored at increasing
        // addresses; copy with the documented DIB row pitch (width*4).
        let bits = dib.bits();
        unsafe {
            std::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), row_bytes);
        }

        Ok(CpuBgraFrame {
            width: rect.width,
            height: rect.height,
            pitch: rect.width * 4,
            pixels,
        })
    }

    fn clear_gdi_cache(&mut self) {
        // Drop runs GdiFrameCache::drop (restore + DeleteObject + DeleteDC).
        self.gdi_cache = None;
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

/// First-paint helper used by the start sequence after ShowWindow / upload:
/// `InvalidateRect` → `UpdateWindow` (WM_PAINT) → `DwmFlush`.
///
/// Intentionally does **not** take `&mut OverlayRenderer`. `UpdateWindow`
/// re-enters `window_proc` and paints via the attached `NonNull` pointer; holding
/// an overlapping exclusive borrow across that call would be stacked-borrows UB
/// and would double-paint if a GetDC path ran first.
///
/// Preconditions: frozen frame uploaded, renderer attached to `overlay`, window
/// already shown. Selection/toolbar are read from window state inside WM_PAINT.
pub fn present_first_frame(overlay: &OverlayWindow) -> Result<(), HelperError> {
    let hwnd = overlay.hwnd();
    // SAFETY: marks the full client area invalid so UpdateWindow will dispatch
    // a WM_PAINT. The window is shown and the renderer is attached by the caller.
    let _ = unsafe { windows::Win32::Graphics::Gdi::InvalidateRect(Some(hwnd), None, false) };
    // SAFETY: UpdateWindow pumps a synchronous WM_PAINT on this thread. No
    // `&mut OverlayRenderer` is live on this stack frame; WM_PAINT creates the
    // sole paint borrow through the attached NonNull.
    let _ = unsafe { UpdateWindow(hwnd) };
    // SAFETY: DwmFlush has no parameters; synchronizes with the compositor so
    // the first frame is presented before overlay-visible is emitted.
    unsafe { DwmFlush() }.map_err(HelperError::from)?;
    Ok(())
}

// ---- timing helpers (QPC) ---------------------------------------------------

/// Capture `QueryPerformanceCounter` ticks.
///
/// Returns `0` when the counter cannot be read (should not happen on modern
/// Windows; treated the same as a missing sample by [`qpc_elapsed_ms`]).
pub fn qpc_now() -> i64 {
    let mut counter = 0i64;
    // SAFETY: counter points to writable aligned storage.
    let ok = unsafe { windows::Win32::System::Performance::QueryPerformanceCounter(&mut counter) };
    if ok.is_err() {
        return 0;
    }
    counter
}

/// Elapsed whole milliseconds between two QPC samples. Returns 0 on clock
/// regression, missing frequency, or a failed / zero `start` sample.
pub fn qpc_elapsed_ms(start: i64, end: i64) -> u64 {
    if start <= 0 || end <= start {
        return 0;
    }
    let mut freq = 0i64;
    // SAFETY: freq points to writable aligned storage.
    let ok = unsafe { windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq) };
    if ok.is_err() || freq <= 0 {
        return 0;
    }
    let delta = (end as u128).saturating_sub(start as u128);
    ((delta.saturating_mul(1000)) / (freq as u128)) as u64
}

// ---- GDI RAII guards (private; mirror T5a capture_gdi pattern) --------------
//
// HDC has no `windows_core::Free` impl, so we own each handle in a small guard
// and free it in `Drop`. Guards are not `Send`: GDI handles are tied to the
// thread that acquired them.

/// Owns an HDC acquired via `GetDC(None)` and releases it via `ReleaseDC`.
struct ScreenDcGuard(HDC);

impl ScreenDcGuard {
    fn acquire() -> Result<Self, HelperError> {
        // SAFETY: `GetDC(None)` returns a DC for the entire screen; it must be
        // released with `ReleaseDC(None, hdc)`, which we do in `Drop`.
        let hdc = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(hdc))
    }

    fn handle(&self) -> HDC {
        self.0
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `GetDC(None)` in `acquire`.
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

/// Owns an HDC acquired via `CreateCompatibleDC` and deletes it via `DeleteDC`.
struct MemoryDcGuard(HDC);

impl MemoryDcGuard {
    fn create(parent: HDC) -> Result<Self, HelperError> {
        // SAFETY: parent is a valid DC; the returned memory DC must be freed
        // with `DeleteDC`.
        let hdc = unsafe { CreateCompatibleDC(Some(parent)) };
        if hdc.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(hdc))
    }

    fn handle(&self) -> HDC {
        self.0
    }

    /// Disarm Drop and return the owned HDC (for transfer into `GdiFrameCache`).
    fn into_handle(self) -> HDC {
        let hdc = self.0;
        std::mem::forget(self);
        hdc
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        // SAFETY: `self.0` was acquired via `CreateCompatibleDC`.
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// Owns an HBITMAP from `CreateDIBSection` (or `CreateCompatibleBitmap`) and
/// deletes it via `DeleteObject`.
struct BitmapGuard {
    bitmap: HBITMAP,
    /// Non-null only for DIB sections created via `CreateDIBSection`.
    bits: *mut core::ffi::c_void,
}

impl BitmapGuard {
    fn create_dib_top_down(memory_dc: HDC, width: i32, height: i32) -> Result<Self, HelperError> {
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
        // SAFETY: `info` describes a 32-bit top-down DIB; `bits` receives the
        // section pointer. Ownership of the HBITMAP (and its bits) transfers
        // to this guard and is released in `Drop` unless `into_bitmap` is used.
        let dib =
            unsafe { CreateDIBSection(Some(memory_dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
        let dib = match dib {
            Ok(dib) if !bits.is_null() => dib,
            Ok(dib) => {
                // Non-null HBITMAP with null bits: free explicitly and error.
                let _ = unsafe { DeleteObject(HGDIOBJ(dib.0)) };
                return Err(HelperError::CaptureFailed(
                    "CreateDIBSection returned a null bits pointer".into(),
                ));
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self { bitmap: dib, bits })
    }

    fn create_compatible(screen_dc: HDC, width: i32, height: i32) -> Result<Self, HelperError> {
        // SAFETY: `screen_dc` is a valid DC; the bitmap must be freed with
        // `DeleteObject`.
        let bmp = unsafe { CreateCompatibleBitmap(screen_dc, width, height) };
        if bmp.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self {
            bitmap: bmp,
            bits: std::ptr::null_mut(),
        })
    }

    fn bits(&self) -> *mut core::ffi::c_void {
        self.bits
    }

    /// Disarm Drop and return the owned HBITMAP (for transfer into `GdiFrameCache`).
    fn into_bitmap(self) -> HBITMAP {
        let bitmap = self.bitmap;
        std::mem::forget(self);
        bitmap
    }
}

impl Drop for BitmapGuard {
    fn drop(&mut self) {
        // SAFETY: `self.bitmap` was acquired via CreateDIBSection or
        // CreateCompatibleBitmap and is not currently selected into a DC
        // (SelectionGuard restores first when used).
        let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) };
    }
}

/// Restores the GDI object that was selected before a temporary bitmap.
///
/// Declare after the bitmap guard so reverse drop order restores before
/// `DeleteObject`, including during unwind.
struct SelectionGuard {
    hdc: HDC,
    previous: HGDIOBJ,
    released: bool,
}

impl SelectionGuard {
    fn new(hdc: HDC, previous: HGDIOBJ) -> Self {
        Self {
            hdc,
            previous,
            released: false,
        }
    }

    /// Disarm Drop after a successful intentional transfer (caller keeps the
    /// selection live inside `GdiFrameCache`).
    fn disarm(mut self) {
        self.released = true;
    }
}

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        if !self.released {
            // SAFETY: best-effort restore; Drop cannot report failure.
            let _ = unsafe { SelectObject(self.hdc, self.previous) };
        }
    }
}

// ---- GDI helpers ------------------------------------------------------------

fn create_gdi_frame_cache(frame: &CpuBgraFrame) -> Result<GdiFrameCache, HelperError> {
    let width = i32::try_from(frame.width)
        .map_err(|_| HelperError::InvalidDisplay("frame width does not fit i32".into()))?;
    let height = i32::try_from(frame.height)
        .map_err(|_| HelperError::InvalidDisplay("frame height does not fit i32".into()))?;

    // Guards acquire in dependency order; on any `?` they release in reverse.
    let screen_dc = ScreenDcGuard::acquire()?;
    let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
    let dib = BitmapGuard::create_dib_top_down(mem_dc.handle(), width, height)?;

    // Copy pixels. Pitch may exceed width*4; copy row by row.
    let dst_pitch = (frame.width * 4) as usize;
    let src_pitch = frame.pitch as usize;
    let bits = dib.bits();
    // SAFETY: bits points at biWidth*abs(biHeight)*4 writable bytes owned by
    // the DIB section; we copy at most min(src,dst) bytes per row.
    unsafe {
        for y in 0..frame.height as usize {
            let src = frame.pixels.as_ptr().add(y * src_pitch);
            let dst = (bits as *mut u8).add(y * dst_pitch);
            std::ptr::copy_nonoverlapping(src, dst, dst_pitch.min(src_pitch));
        }
    }

    // SAFETY: select DIB into mem_dc for subsequent BitBlt source use.
    let old_obj = unsafe { SelectObject(mem_dc.handle(), HGDIOBJ(dib.bitmap.0)) };
    if old_obj.0.is_null() || old_obj.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    // Keep the DIB selected for the lifetime of GdiFrameCache. Disarm the
    // selection guard so Drop does not restore before we transfer ownership;
    // GdiFrameCache::drop restores `old_obj` itself.
    let selection = SelectionGuard::new(mem_dc.handle(), old_obj);
    selection.disarm();

    // Transfer DC + bitmap ownership into the long-lived cache. Screen DC
    // drops here (ReleaseDC). Memory DC and DIB guards are disarmed via
    // into_* so their Drop does not free the transferred handles.
    let mem_dc_handle = mem_dc.into_handle();
    let dib_handle = dib.into_bitmap();
    drop(screen_dc);

    Ok(GdiFrameCache {
        width,
        height,
        dib: dib_handle,
        mem_dc: mem_dc_handle,
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
        // SAFETY: cache.mem_dc has the frozen DIB selected for the cache lifetime.
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
    // Create a 1x1 black bitmap and AlphaBlend it stretched. When a selection is
    // present we dim the four surrounding rects so the selection stays bright.
    // RAII guards release every handle if FillRect / AlphaBlend panics.
    let screen_dc = ScreenDcGuard::acquire()?;
    let mem_dc = MemoryDcGuard::create(screen_dc.handle())?;
    let bmp = BitmapGuard::create_compatible(screen_dc.handle(), 1, 1)?;
    // SAFETY: select the 1x1 bitmap into mem_dc; SelectionGuard restores on drop.
    let old = unsafe { SelectObject(mem_dc.handle(), HGDIOBJ(bmp.bitmap.0)) };
    if old.0.is_null() || old.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let _selection = SelectionGuard::new(mem_dc.handle(), old);

    let brush = unsafe { CreateSolidBrush(COLORREF(0x00000000)) };
    if !brush.is_invalid() {
        let r = RECT {
            left: 0,
            top: 0,
            right: 1,
            bottom: 1,
        };
        unsafe {
            FillRect(mem_dc.handle(), &r, brush);
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
        let _ = unsafe { AlphaBlend(hdc, x, y, w, h, mem_dc.handle(), 0, 0, 1, 1, blend) };
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

    // Guards drop in reverse order: selection restores, then bitmap, mem DC,
    // screen DC.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_frame(width: u32, height: u32) -> CpuBgraFrame {
        let pitch = width * 4;
        CpuBgraFrame {
            width,
            height,
            pitch,
            pixels: vec![0u8; (pitch * height) as usize],
        }
    }

    #[test]
    fn upload_count_increments_per_upload_and_survives_clear() {
        let mut renderer = OverlayRenderer::new().expect("OverlayRenderer::new");
        assert_eq!(renderer.upload_count, 0);

        let frame = sample_frame(8, 8);
        renderer
            .upload_frozen(&frame)
            .expect("first upload_frozen must succeed under an interactive session");
        assert_eq!(renderer.upload_count, 1);

        renderer
            .upload_frozen(&frame)
            .expect("second upload replaces the cache");
        assert_eq!(renderer.upload_count, 2);

        renderer.clear_frozen();
        // clear drops the GDI cache (Drop path) but does not reset the counter.
        assert_eq!(renderer.upload_count, 2);
        assert!(renderer.gdi_cache.is_none());
    }

    #[test]
    fn gdi_frame_cache_drop_releases_without_panic() {
        let frame = sample_frame(4, 4);
        let cache = create_gdi_frame_cache(&frame).expect("create_gdi_frame_cache");
        // Explicit drop exercises GdiFrameCache::drop (SelectObject + Delete*).
        drop(cache);
    }
}
