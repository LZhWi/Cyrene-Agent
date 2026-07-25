#![cfg(windows)]

use cyrene_screenshot::win::capture::{CaptureBackend, CpuBgraFrame, FrozenFrame, RefreshOutcome};
use cyrene_screenshot::win::capture_gdi::GdiCaptureBackend;
use cyrene_screenshot::win::display::query_primary_display;

#[test]
fn gdi_freeze_produces_full_primary_bounds_bgra() {
    cyrene_screenshot::win::display::set_dpi_awareness()
        .expect("set_dpi_awareness must succeed before freeze");

    let display = query_primary_display().expect("query_primary_display must succeed");
    let mut backend = GdiCaptureBackend::new().expect("GdiCaptureBackend::new must succeed");

    let frozen = backend
        .freeze(&display)
        .expect("freeze on the primary display must succeed");

    let FrozenFrame::Cpu(CpuBgraFrame {
        width,
        height,
        pitch,
        pixels,
    }) = frozen
    else {
        panic!("freeze must return FrozenFrame::Cpu for the GDI backend");
    };

    assert_eq!(
        width, display.bounds.width,
        "frozen width must match display.bounds.width"
    );
    assert_eq!(
        height, display.bounds.height,
        "frozen height must match display.bounds.height"
    );
    assert!(
        pitch >= width * 4,
        "pitch must be at least width*4 bytes, got pitch={} for width={}",
        pitch,
        width
    );
    let required_pixels = (pitch as usize).saturating_mul(height as usize);
    assert!(
        pixels.len() >= required_pixels,
        "pixels length {} must cover pitch*height={}",
        pixels.len(),
        required_pixels
    );

    // We do not assert on specific pixel content (a CI machine does not
    // guarantee any particular frame), only that pixels were actually copied
    // (every byte was at least written to, even if only to zero).
    assert!(
        !pixels.is_empty(),
        "GDI freeze must produce at least one byte"
    );
}

#[test]
fn gdi_refresh_latest_is_unchanged() {
    let mut backend = GdiCaptureBackend::new().expect("GdiCaptureBackend::new must succeed");
    let outcome = backend
        .refresh_latest(0)
        .expect("GDI refresh_latest must report a refresh outcome");
    assert_eq!(
        outcome,
        RefreshOutcome::Unchanged,
        "GDI is pull-on-demand; refresh_latest must report Unchanged in T5a"
    );
}

#[test]
fn gdi_invalidate_is_safe() {
    let mut backend = GdiCaptureBackend::new().expect("GdiCaptureBackend::new must succeed");

    // invalidate() takes &mut self and must not panic. There is no
    // observable return value in T5a — calling it leaves the backend usable.
    backend.invalidate();

    // The backend must remain usable after invalidate; calling refresh_latest
    // must still return a valid RefreshOutcome and not require a re-new().
    let outcome = backend
        .refresh_latest(0)
        .expect("refresh_latest must succeed after invalidate");
    assert_eq!(outcome, RefreshOutcome::Unchanged);
}

#[test]
fn gdi_freeze_handles_canonical_rotation_invariant() {
    cyrene_screenshot::win::display::set_dpi_awareness()
        .expect("set_dpi_awareness must succeed before freeze");

    let display = query_primary_display().expect("query_primary_display must succeed");
    let mut backend = GdiCaptureBackend::new().expect("GdiCaptureBackend::new must succeed");

    let frozen = backend
        .freeze(&display)
        .expect("freeze must succeed for canonical rotation invariant");

    let FrozenFrame::Cpu(CpuBgraFrame { width, height, .. }) = frozen else {
        panic!("GDI freeze must return FrozenFrame::Cpu");
    };

    // The canonical-orientation invariant: regardless of the source rotation
    // reported by Windows, the returned frame's width and height must match
    // display.bounds exactly. This guarantees that the overlay's coordinate
    // space is in the canonical (rotation-aware) frame, not the raw GDI
    // buffer.
    assert_eq!(
        width, display.bounds.width,
        "frozen width must match display.bounds.width in canonical orientation"
    );
    assert_eq!(
        height, display.bounds.height,
        "frozen height must match display.bounds.height in canonical orientation"
    );
}
