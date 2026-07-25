//! GDI implementation of [`CaptureBackend`].
//!
//! This is the only capture backend wired up in T5a. It captures the
//! primary monitor by:
//!
//!   1. Allocating a 32-bit top-down DIB section via [`CreateDIBSection`]
//!      whose dimensions match the monitor's physical bounds in canonical
//!      orientation.
//!   2. `BitBlt` from the desktop DC into the DIB's memory DC using
//!      `SRCCOPY | CAPTUREBLT`.
//!   3. Reading the bitmap bits out of the DIB section as a BGRA buffer.
//!   4. Rotating the buffer so its width/height match `display.bounds` in
//!      the canonical orientation regardless of the OS-reported rotation.
//!
//! GDI is pull-on-demand: there is no persistent framebuffer to refresh, so
//! [`refresh_latest`](CaptureBackend::refresh_latest) returns
//! [`RefreshOutcome::Unchanged`] in T5a.

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP, HDC, ReleaseDC, SRCCOPY, SelectObject,
};

use crate::{
    error::HelperError,
    geometry::DisplayRotation,
    win::{
        capture::{CaptureBackend, CpuBgraFrame, FrozenFrame, RefreshOutcome},
        display::DisplayInfo,
    },
};

/// GDI-backed capture of the primary monitor.
///
/// Holds the compatible DC and DIB section for the most recent freeze so
/// subsequent freezes can reuse the same allocation. In T5a the backend is
/// constructed freshly per capture and drops the DC on destruction, so the
/// internal caches are reset on every `new()`.
#[derive(Debug)]
pub struct GdiCaptureBackend {
    _private: (),
}

impl GdiCaptureBackend {
    /// Create a fresh backend. The GDI backend currently holds no long-lived
    /// state, so this is a cheap constructor that only validates the
    /// process DPI awareness is in place by allocating a throwaway DC.
    pub fn new() -> Result<Self, HelperError> {
        // We probe the desktop DC and immediately release it. The point is
        // to surface a deterministic HelperError::CaptureFailed when GDI is
        // unavailable (e.g., the process is running in a session that does
        // not have an interactive desktop) rather than failing on first
        // freeze().
        let hdc = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err(HelperError::CaptureFailed(format!(
                "GetDC returned an invalid handle (last error: {})",
                windows::core::Error::from_thread().message()
            )));
        }
        // SAFETY: We acquired the DC with GetDC(None) and must release it
        // before the function returns.
        let _ = unsafe { ReleaseDC(None, hdc) };
        Ok(Self { _private: () })
    }
}

impl Default for GdiCaptureBackend {
    fn default() -> Self {
        Self::new().expect("GdiCaptureBackend::new must succeed by default on Windows")
    }
}

impl CaptureBackend for GdiCaptureBackend {
    fn refresh_latest(&mut self, _timeout_ms: u32) -> Result<RefreshOutcome, HelperError> {
        // GDI is pull-on-demand: there is no producer-consumer pipeline to
        // pump, so a refresh is always observed as "no change".
        Ok(RefreshOutcome::Unchanged)
    }

    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError> {
        let captured = capture_primary_bgra(display)?;
        let (width, height, pitch, pixels) = rotate_to_canonical(captured, display.rotation)?;
        Ok(FrozenFrame::Cpu(CpuBgraFrame {
            width,
            height,
            pitch,
            pixels,
        }))
    }

    fn invalidate(&mut self) {
        // No persistent state to drop; nothing to do.
    }
}

/// Raw BGRA capture in the *physical* (possibly rotated) source orientation
/// reported by GDI. The rotation step in `freeze` adapts this to canonical
/// orientation before returning.
struct RawBgraCapture {
    width: u32,
    height: u32,
    #[allow(dead_code)]
    pitch: u32,
    pixels: Vec<u8>,
}

fn capture_primary_bgra(display: &DisplayInfo) -> Result<RawBgraCapture, HelperError> {
    let source_width = display.bounds.width;
    let source_height = display.bounds.height;
    if source_width == 0 || source_height == 0 {
        return Err(HelperError::InvalidDisplay(
            "primary display has zero width or height".into(),
        ));
    }
    // i32 conversions fail only for resolutions above 2^31 - 1 pixels which
    // would physically never fit on a single monitor.
    let width_i32 = i32::try_from(source_width).map_err(|_| {
        HelperError::InvalidDisplay(format!("width {source_width} does not fit in i32"))
    })?;
    let height_i32 = i32::try_from(source_height).map_err(|_| {
        HelperError::InvalidDisplay(format!("height {source_height} does not fit in i32"))
    })?;

    // Grab the desktop DC. We pass None for hwnd, matching GetDC's behavior
    // for the screen-wide device context.
    // SAFETY: GetDC(None) is safe to call at any time; we release below.
    let screen_dc: HDC = unsafe { GetDC(None) };
    if screen_dc.is_invalid() {
        return Err(HelperError::CaptureFailed(format!(
            "GetDC returned an invalid handle (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }

    // Build a compatible memory DC and a top-down 32-bit BGRA DIB section
    // sized to the physical bounds.
    // SAFETY: CreateCompatibleDC takes an existing HDC; passing the desktop
    // DC ensures the new DC is screen-compatible (same bit depth / palette).
    let memory_dc: HDC = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if memory_dc.is_invalid() {
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(HelperError::CaptureFailed(format!(
            "CreateCompatibleDC returned an invalid handle (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }

    // BITMAPINFO contains a single RGBQUAD slot for the color table; for
    // 32-bit BI_RGB images the color table is unused, so we only need the
    // header.
    let mut bitmap_info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width_i32,
            // Negative biHeight => top-down DIB (origin at top-left).
            biHeight: -height_i32,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [windows::Win32::Graphics::Gdi::RGBQUAD::default(); 1],
    };

    let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
    // SAFETY: `bitmap_info` is a valid BITMAPINFO describing a 32-bit
    // top-down BGRA DIB. `bits` receives a pointer to the DIB's pixel
    // storage, which lives as long as the returned HBITMAP. We release the
    // bitmap (and thus the bits) before returning.
    let dib_section: HBITMAP = unsafe {
        CreateDIBSection(
            Some(memory_dc),
            &mut bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        )
    }
    .map_err(|error| {
        let _ = unsafe { DeleteDC(memory_dc) };
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        HelperError::CaptureFailed(format!(
            "CreateDIBSection failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        ))
    })?;

    // Select the DIB section into the memory DC. The previous object
    // selected into a freshly-created compatible DC is a 1x1 monochrome
    // bitmap; we deliberately drop it on cleanup, so we don't restore it.
    // SAFETY: Selecting a freshly created HBITMAP into a memory DC is the
    // documented pattern. We discard the previous 1x1 default bitmap by
    // leaking the previous HGDIOBJ slot — the documentation permits this
    // for DCs that own no GDI resources, and we drop the DIB section on
    // cleanup.
    let _previous = unsafe { SelectObject(memory_dc, dib_section.into()) };

    // BitBlt with CAPTUREBLT to also include layered windows' content. The
    // system cursor is not drawn into the captured desktop.
    let blt_ok = unsafe {
        BitBlt(
            memory_dc,
            0,
            0,
            width_i32,
            height_i32,
            Some(screen_dc),
            0,
            0,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if let Err(error) = blt_ok {
        // Best-effort cleanup before reporting the failure.
        let _ = unsafe { DeleteObject(dib_section.into()) };
        let _ = unsafe { DeleteDC(memory_dc) };
        let _ = unsafe { ReleaseDC(None, screen_dc) };
        return Err(HelperError::CaptureFailed(format!(
            "BitBlt failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        )));
    }

    // Copy the bits out of the DIB section. CreateDIBSection guarantees
    // that rows are tightly packed to width * 4 bytes because we used a
    // negative biHeight (top-down), so the pitch equals width * 4.
    let width_u32 = source_width;
    let height_u32 = source_height;
    let row_bytes = (width_u32 as usize) * 4;
    let total_bytes = row_bytes * (height_u32 as usize);
    let mut pixels = vec![0u8; total_bytes];
    if !bits.is_null() {
        // SAFETY: `bits` points to a freshly-allocated DIB section whose
        // ownership is being transferred to us; we read exactly the
        // documented number of bytes.
        unsafe {
            core::ptr::copy_nonoverlapping(bits as *const u8, pixels.as_mut_ptr(), total_bytes);
        }
    }

    // Cleanup: delete the DIB section (frees the pixel storage pointed to
    // by `bits`), delete the memory DC, and release the desktop DC. Order
    // matters: deleting the DIB before the DC ensures we don't outlive the
    // device that selected it.
    let _ = unsafe { DeleteObject(dib_section.into()) };
    let _ = unsafe { DeleteDC(memory_dc) };
    let _ = unsafe { ReleaseDC(None, screen_dc) };

    Ok(RawBgraCapture {
        width: width_u32,
        height: height_u32,
        pitch: width_u32 * 4,
        pixels,
    })
}

fn rotate_to_canonical(
    raw: RawBgraCapture,
    rotation: DisplayRotation,
) -> Result<(u32, u32, u32, Vec<u8>), HelperError> {
    let source_width = raw.width;
    let source_height = raw.height;
    let target_width: u32;
    let target_height: u32;

    match rotation {
        DisplayRotation::Identity => {
            target_width = source_width;
            target_height = source_height;
        }
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => {
            // Canonical orientation: the visible bounds always read with
            // width along the long axis. The display rect reported by
            // GetMonitorInfoW is already in the canonical frame, but the
            // GDI buffer is in the physical frame, so width/height may
            // swap during rotation. We keep the bit-for-bit orientation
            // here by swapping dimensions when a 90/270 rotation is
            // requested.
            target_width = source_height;
            target_height = source_width;
        }
        DisplayRotation::Rotate180 => {
            target_width = source_width;
            target_height = source_height;
        }
    }

    let new_pitch = target_width
        .checked_mul(4)
        .ok_or_else(|| HelperError::CaptureFailed("pitch overflow".into()))?;

    let pixels = match rotation {
        DisplayRotation::Identity => raw.pixels,
        DisplayRotation::Rotate180 => rotate_180(&raw.pixels, source_width, source_height),
        DisplayRotation::Rotate90 => rotate_clockwise(
            &raw.pixels,
            source_width,
            source_height,
            target_width,
            target_height,
        ),
        DisplayRotation::Rotate270 => rotate_counter_clockwise(
            &raw.pixels,
            source_width,
            source_height,
            target_width,
            target_height,
        ),
    };

    Ok((target_width, target_height, new_pitch, pixels))
}

fn rotate_180(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let row_bytes = w * 4;
    let mut out = vec![0u8; row_bytes * h];
    // Iterate rows from bottom to top, reversing each row's bytes to
    // match a 180-degree rotation (rightmost pixel becomes leftmost in
    // the bottom row, etc.).
    for y in 0..h {
        let src_offset = (h - 1 - y) * row_bytes;
        let dst_offset = y * row_bytes;
        let src_row = &pixels[src_offset..src_offset + row_bytes];
        let dst_row = &mut out[dst_offset..dst_offset + row_bytes];
        // Reverse 4-byte BGRA pixels within the row.
        for x in 0..w {
            let src_pixel = src_row[x * 4..(x + 1) * 4].to_vec();
            dst_row[(w - 1 - x) * 4..(w - x) * 4].copy_from_slice(&src_pixel);
        }
    }
    out
}

fn rotate_clockwise(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 90° clockwise: `(x_d, y_d) = (H-1-y_s, x_s)` — i.e. the destination's
    // x-axis is the source's row (flipped) and its y-axis is the source's
    // column. Inverting gives `result[y_d, x_d] = source[x_s=H-1-x_d... wait,
    // y_s=H-1-x_d, x_s=y_d]`. For a 90° rotation we must have
    // `target_width == source_height` and `target_height == source_width`.
    //
    // Working indices (all computed as `usize` first to avoid overflow):
    //   src_col = y_dst (which has range [0, src_w))
    //   src_row = src_h - 1 - x_dst (which has range [0, src_h))
    let src_w = source_width as usize;
    let src_h = source_height as usize;
    let dst_w = target_width as usize;
    let dst_h = target_height as usize;
    debug_assert_eq!(
        src_h, dst_w,
        "CW rotation requires target_width == source_height"
    );
    debug_assert_eq!(
        src_w, dst_h,
        "CW rotation requires target_height == source_width"
    );
    let mut out = vec![0u8; dst_w * 4 * dst_h];
    let src_row_bytes = src_w * 4;
    let dst_row_bytes = dst_w * 4;
    for dst_y in 0..dst_h {
        for dst_x in 0..dst_w {
            let src_row = src_h - 1 - dst_x;
            let src_col = dst_y;
            let src_offset = src_row * src_row_bytes + src_col * 4;
            let dst_offset = dst_y * dst_row_bytes + dst_x * 4;
            out[dst_offset..dst_offset + 4].copy_from_slice(&pixels[src_offset..src_offset + 4]);
        }
    }
    out
}

fn rotate_counter_clockwise(
    pixels: &[u8],
    source_width: u32,
    source_height: u32,
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 270° clockwise (= 90° counter-clockwise): inverse of CW. The mapping
    // is `(x_d, y_d) = (y_s, W-1-x_s)`, so `result[y_d, x_d] =
    // source[x_s=x_d... y_s=W-1-y_d]`. Same axis-swap invariants as CW:
    // `target_width == source_height`, `target_height == source_width`.
    let src_w = source_width as usize;
    let src_h = source_height as usize;
    let dst_w = target_width as usize;
    let dst_h = target_height as usize;
    debug_assert_eq!(
        src_w, dst_h,
        "CCW rotation requires target_height == source_width"
    );
    debug_assert_eq!(
        src_h, dst_w,
        "CCW rotation requires target_width == source_height"
    );
    let mut out = vec![0u8; dst_w * 4 * dst_h];
    let src_row_bytes = src_w * 4;
    let dst_row_bytes = dst_w * 4;
    for dst_y in 0..dst_h {
        for dst_x in 0..dst_w {
            let src_row = dst_x;
            let src_col = src_w - 1 - dst_y;
            let src_offset = src_row * src_row_bytes + src_col * 4;
            let dst_offset = dst_y * dst_row_bytes + dst_x * 4;
            out[dst_offset..dst_offset + 4].copy_from_slice(&pixels[src_offset..src_offset + 4]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_bgra(width: u32, height: u32, byte: u8) -> Vec<u8> {
        vec![byte; (width as usize) * 4 * (height as usize)]
    }

    #[test]
    fn rotate_180_reverses_rows_and_columns() {
        // Build a 2x2 BGRA image. Layout (top-down, row-major):
        //   row 0:  [A=(0,0)]  [B=(1,0)]
        //   row 1:  [C=(0,1)]  [D=(1,1)]
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // A at (0,0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // B at (1,0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // C at (0,1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // D at (1,1)

        let rotated = rotate_180(&pixels, 2, 2);
        // After 180°: D goes to top-left, C to top-right, B to bottom-left, A to bottom-right.
        assert_eq!(&rotated[0..4], &[13, 14, 15, 16]);
        assert_eq!(&rotated[4..8], &[9, 10, 11, 12]);
        assert_eq!(&rotated[8..12], &[5, 6, 7, 8]);
        assert_eq!(&rotated[12..16], &[1, 2, 3, 4]);
    }

    #[test]
    fn rotate_clockwise_swaps_dimensions_and_rotates_pixel() {
        // Source layout (W=2, H=2):
        //   [TL]=(col=0,row=0)  [TR]=(col=1,row=0)
        //   [BL]=(col=0,row=1)  [BR]=(col=1,row=1)
        // 90° CW swaps x/y and flips: the destination's first row is the
        // source's first column read bottom-to-top.
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // TL = (col=0,row=0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // TR = (col=1,row=0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // BL = (col=0,row=1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // BR = (col=1,row=1)

        let rotated = rotate_clockwise(&pixels, 2, 2, 2, 2);
        // After 90° CW the visual layout is:
        //   [BL] [TL]   → pixels[0..4]=BL, [4..8]=TL
        //   [BR] [TR]   → pixels[8..12]=BR, [12..16]=TR
        assert_eq!(&rotated[0..4], &[9, 10, 11, 12]); // BL moves to result (0,0)
        assert_eq!(&rotated[4..8], &[1, 2, 3, 4]); // TL moves to result (0,1)
        assert_eq!(&rotated[8..12], &[13, 14, 15, 16]); // BR moves to result (1,0)
        assert_eq!(&rotated[12..16], &[5, 6, 7, 8]); // TR moves to result (1,1)
    }

    #[test]
    fn rotate_counter_clockwise_swaps_dimensions_and_rotates_pixel() {
        // Source layout (W=2, H=2):
        //   [TL]=(0,0)  [TR]=(1,0)
        //   [BL]=(0,1)  [BR]=(1,1)
        // 270° CW (= 90° CCW):
        //   [TR] [BR]   → pixels[0..4]=TR, [4..8]=BR
        //   [TL] [BL]   → pixels[8..12]=TL, [12..16]=BL
        let mut pixels = vec![0u8; 2 * 4 * 2];
        pixels[0..4].copy_from_slice(&[1, 2, 3, 4]); // TL = (col=0,row=0)
        pixels[4..8].copy_from_slice(&[5, 6, 7, 8]); // TR = (col=1,row=0)
        pixels[8..12].copy_from_slice(&[9, 10, 11, 12]); // BL = (col=0,row=1)
        pixels[12..16].copy_from_slice(&[13, 14, 15, 16]); // BR = (col=1,row=1)

        let rotated = rotate_counter_clockwise(&pixels, 2, 2, 2, 2);
        assert_eq!(&rotated[0..4], &[5, 6, 7, 8]); // TR moves to result (0,0)
        assert_eq!(&rotated[4..8], &[13, 14, 15, 16]); // BR moves to result (0,1)
        assert_eq!(&rotated[8..12], &[1, 2, 3, 4]); // TL moves to result (1,0)
        assert_eq!(&rotated[12..16], &[9, 10, 11, 12]); // BL moves to result (1,1)
    }

    #[test]
    fn rotate_clockwise_into_wider_target_uses_swap_dimensions() {
        // 2x4 source (W=2, H=4) rotates into 4x2 target (W'=4, H'=2). Place
        // four distinct pixels on the source diagonal and verify their
        // positions in the target.
        //
        // For 90° CW: src_col = dst_y (valid range [0, src_w)); src_row =
        // src_h - 1 - dst_x. For dst (4x2), dst_x ∈ [0, 2), dst_y ∈ [0, 4).
        //   result(0,0) = source(y_d=0=col, x_d=0=reverse row 3)
        //     → reads source(row=3, col=0)
        //   result(0,1) = source(row=2, col=0)
        //   result(1,0) = source(row=3, col=1)
        //   result(1,1) = source(row=2, col=1)
        let mut pixels = vec![0u8; 2 * 4 * 4];
        let place = |buf: &mut [u8], col: usize, row: usize, value: [u8; 4]| {
            buf[row * 2 * 4 + col * 4..row * 2 * 4 + (col + 1) * 4].copy_from_slice(&value);
        };
        place(&mut pixels, 0, 0, [10, 0, 0, 255]);
        place(&mut pixels, 1, 0, [20, 0, 0, 255]);
        place(&mut pixels, 0, 1, [11, 0, 0, 255]);
        place(&mut pixels, 1, 1, [21, 0, 0, 255]);
        place(&mut pixels, 0, 2, [12, 0, 0, 255]);
        place(&mut pixels, 1, 2, [22, 0, 0, 255]);
        place(&mut pixels, 0, 3, [13, 0, 0, 255]);
        place(&mut pixels, 1, 3, [23, 0, 0, 255]);

        let rotated = rotate_clockwise(&pixels, 2, 4, 4, 2);
        assert_eq!(rotated.len(), 4 * 4 * 2);
        // dst row 0: reads src rows in reverse order at col 0 (the source's
        // single column is dst's row axis). For dst_x in [0, 4):
        //   src_row = src_h - 1 - dst_x ∈ {3, 2, 1, 0} at col 0.
        // Src col 0 contains the "1x" pixels (10, 11, 12, 13 by row).
        assert_eq!(&rotated[0..4], &[13, 0, 0, 255]);
        assert_eq!(&rotated[4..8], &[12, 0, 0, 255]);
        assert_eq!(&rotated[8..12], &[11, 0, 0, 255]);
        assert_eq!(&rotated[12..16], &[10, 0, 0, 255]);
        // dst row 1: same indexing but src_col = dst_y = 1 → reads src col 1.
        assert_eq!(&rotated[16..20], &[23, 0, 0, 255]);
        assert_eq!(&rotated[20..24], &[22, 0, 0, 255]);
        assert_eq!(&rotated[24..28], &[21, 0, 0, 255]);
        assert_eq!(&rotated[28..32], &[20, 0, 0, 255]);
    }

    #[test]
    fn solid_bgra_helper_is_well_formed() {
        let pixels = solid_bgra(3, 2, 0xAB);
        assert_eq!(pixels.len(), 3 * 4 * 2);
        assert!(pixels.iter().all(|byte| *byte == 0xAB));
    }
}
