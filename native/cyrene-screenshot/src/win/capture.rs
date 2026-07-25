//! Capture backend abstraction.
//!
//! [`CaptureBackend`] is the only interface the rest of the helper consumes
//! to obtain a frozen frame of the primary monitor. In T5a the only
//! implementation wired up is [`crate::win::capture_gdi::GdiCaptureBackend`];
//! a Direct3D-backed implementation that produces
//! [`FrozenFrame::Gpu`](FrozenFrame::Gpu) is reserved for a later task and
//! the `Gpu` variant is intentionally opaque.

use crate::{error::HelperError, win::display::DisplayInfo};

/// BGRA pixels for a frozen frame, captured from GDI (and later, possibly,
/// from a Direct3D staging texture that the GPU path would copy into a CPU
/// buffer).
///
/// Pitch is the number of bytes per row and may exceed `width * 4` because
/// GDI aligns DIB rows to 4-byte boundaries. All pixel data is laid out in
/// canonical orientation: callers do not need to know the physical rotation
/// of the source display because the rotation has already been normalized
/// by the time a [`CpuBgraFrame`] is produced.
#[derive(Debug, Clone)]
pub struct CpuBgraFrame {
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub pixels: Vec<u8>,
}

/// Opaque placeholder for the GPU capture path. Task 7 will populate this
/// with a Direct3D11 texture handle; in T5a no backend returns it.
#[derive(Debug)]
pub struct GpuFrozenFrame;

/// The result of a successful [`CaptureBackend::freeze`].
///
/// `Cpu` is the only variant wired up in T5a. The `Gpu` variant exists so
/// downstream code (T5b overlay state machine, T6 clipboard path) can
/// exhaustively match without needing to be modified when the GPU path
/// lands in Task 7.
#[derive(Debug)]
pub enum FrozenFrame {
    Gpu(GpuFrozenFrame),
    Cpu(CpuBgraFrame),
}

/// Outcome reported by [`CaptureBackend::refresh_latest`].
///
/// `Unchanged` is the only outcome the GDI backend ever reports because
/// GDI is pull-on-demand. The `Updated` and `Lost` variants are reserved
/// for capture backends that maintain their own continuous frame buffer
/// (DXGI duplication, Media Foundation, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    Updated,
    Unchanged,
    Lost,
}

/// Capture backend capability surface.
///
/// Implementations must be `Send`-safe for the helper's single-threaded use
/// in T5a but should not assume they are `Sync`; the helper UI thread is the
/// only consumer.
pub trait CaptureBackend {
    /// Refresh the backend's notion of the latest frame, returning whether
    /// the frame is new, unchanged, or lost. The `timeout_ms` is a hint; the
    /// GDI backend ignores it.
    fn refresh_latest(&mut self, timeout_ms: u32) -> Result<RefreshOutcome, HelperError>;

    /// Freeze the current frame of the primary display, producing a
    /// [`FrozenFrame`] whose dimensions match `display.bounds` in canonical
    /// orientation. Implementations must already know the physical bounds of
    /// the source desktop; the caller passes `display` so the backend can
    /// apply any rotation transform.
    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError>;

    /// Invalidate any persistent state held by the backend so the next
    /// freeze produces a fresh capture. T5a backends hold no persistent
    /// state and may treat this as a no-op.
    fn invalidate(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_outcome_variants_are_distinct() {
        assert_ne!(RefreshOutcome::Updated, RefreshOutcome::Unchanged);
        assert_ne!(RefreshOutcome::Updated, RefreshOutcome::Lost);
        assert_ne!(RefreshOutcome::Unchanged, RefreshOutcome::Lost);
    }

    #[test]
    fn refresh_outcome_is_copy() {
        let value = RefreshOutcome::Unchanged;
        let copy = value;
        assert_eq!(value, copy);
    }
}
