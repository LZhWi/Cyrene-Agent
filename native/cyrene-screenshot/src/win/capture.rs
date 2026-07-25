//! Capture backend abstraction.
//!
//! [`CaptureBackend`] is the only interface the rest of the helper consumes
//! to obtain a frozen frame of the primary monitor. Task 7 wires DXGI Desktop
//! Duplication as the primary path; [`crate::win::capture_gdi::GdiCaptureBackend`]
//! remains the documented fallback when DXGI init fails or when the system
//! reports that the cursor is composited into the desktop.

use crate::{
    error::HelperError,
    geometry::{DisplayRotation, RectI},
    win::display::DisplayInfo,
};

/// BGRA pixels for a frozen frame, captured from GDI or from a Direct3D
/// staging texture that the GPU path copied into a CPU buffer.
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

/// Opaque handle to a frozen GPU frame produced by the DXGI capture path.
///
/// The DXGI backend keeps the captured frame on the GPU until the user commits
/// the selection (at which point a small `CopySubresourceRegion` + `Map` reads
/// only the selection rectangle). The frozen texture plus its D2D bitmap live
/// for the duration of the active interaction; [`crate::win::renderer::OverlayRenderer`]
/// binds the D2D bitmap so subsequent repaints do not re-upload the frame.
///
/// Concrete COM types are intentionally hidden from this module so the trait
/// surface remains `Send`-friendly for the helper's UI-thread usage.
#[derive(Debug)]
pub struct GpuFrozenFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) rotation: DisplayRotation,
    /// Backing `ID3D11Texture2D` (latest → frozen, identity rotation).
    pub(crate) frozen: windows::Win32::Graphics::Direct3D11::ID3D11Texture2D,
    /// Display-oriented `ID3D11Texture2D` matching canonical `display.bounds`.
    pub(crate) frozen_oriented: Option<windows::Win32::Graphics::Direct3D11::ID3D11Texture2D>,
    pub(crate) device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    pub(crate) context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
}

/// The result of a successful [`CaptureBackend::freeze`].
#[derive(Debug)]
pub enum FrozenFrame {
    Gpu(GpuFrozenFrame),
    Cpu(CpuBgraFrame),
}

/// Outcome reported by [`CaptureBackend::refresh_latest`].
///
/// `Unchanged` is the only outcome the GDI backend ever reports because
/// GDI is pull-on-demand. The `Updated` and `Lost` variants are produced by
/// capture backends that maintain their own continuous frame buffer (DXGI
/// duplication).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshOutcome {
    Updated,
    Unchanged,
    Lost,
}

/// Counters that prove the GPU capture path is delivering on its promise: no
/// full-screen CPU readback between `Start` and `overlay-visible`, and
/// exactly one selection readback at commit.
///
/// Fields are cumulative monotonic counters exposed on the wire via
/// `Event::OverlayVisible` and `Event::CaptureReleased` so integration tests
/// can assert the documented invariants without a private inspector.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct CaptureDiagnostics {
    /// Stable backend identifier surfaced on the wire (e.g. `"dxgi"`, `"gdi"`).
    pub backend: &'static str,
    /// Total `Map`/`BitBlt` operations that pulled a full display-sized buffer
    /// back to the CPU. DXGI must keep this at zero between `Start` and
    /// `overlay-visible`.
    pub full_frame_cpu_readbacks: u64,
    /// Total `Map`/`BitBlt` operations that pulled the *selection* rectangle
    /// (or smaller) back to the CPU. Both backends increment this at commit.
    pub selection_cpu_readbacks: u64,
    /// Times `AcquireNextFrame` returned `S_OK` (DXGI) or freeze succeeded
    /// (GDI). GDI counts a single 1 here at first freeze.
    pub latest_copies: u64,
    /// Times the DXGI duplication + textures were rebuilt (ACCESS_LOST,
    /// display change, DPI change). Zero on a healthy desktop.
    pub duplication_rebuilds: u64,
}

/// Capture backend capability surface.
///
/// Implementations must be `Send`-safe for the helper's single-threaded use
/// in T5a but should not assume they are `Sync`; the helper UI thread is the
/// only consumer.
pub trait CaptureBackend {
    /// Stable name of this backend; used by [`CaptureDiagnostics::backend`]
    /// and surfaced on the wire.
    fn name(&self) -> &'static str;

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

    /// Snapshot the backend's running counters. The returned struct is
    /// intentionally `Copy` so callers can read it without disturbing the
    /// backend's internal state.
    fn diagnostics(&self) -> CaptureDiagnostics;
}

/// Convenience: copy of the active frozen frame's canonical bounds. Used by
/// `OverlayApp` to size the D2D bitmap without re-reading `display.bounds`.
pub fn frozen_canonical_bounds(frozen: &FrozenFrame, display_bounds: RectI) -> (u32, u32) {
    let (w, h) = match frozen {
        FrozenFrame::Gpu(gpu) => (gpu.width, gpu.height),
        FrozenFrame::Cpu(cpu) => (cpu.width, cpu.height),
    };
    if w == 0 || h == 0 {
        (display_bounds.width, display_bounds.height)
    } else {
        (w, h)
    }
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

    #[test]
    fn diagnostics_default_is_all_zero() {
        let d = CaptureDiagnostics::default();
        assert_eq!(d.backend, "");
        assert_eq!(d.full_frame_cpu_readbacks, 0);
        assert_eq!(d.selection_cpu_readbacks, 0);
        assert_eq!(d.latest_copies, 0);
        assert_eq!(d.duplication_rebuilds, 0);
    }
}
