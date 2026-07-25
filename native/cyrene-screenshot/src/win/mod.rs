//! Windows-specific capture and display backend.
//!
//! This module is the only place in the helper that talks directly to the
//! Win32 graphics APIs for the purpose of freezing the primary display. T5a
//! establishes the boundary:
//!
//!   * [`display`] establishes DPI awareness and queries the primary monitor.
//!   * [`capture`] defines the [`FrozenFrame`] / [`CaptureBackend`] abstraction
//!     that the rest of the helper consumes. The Gpu variant is an opaque
//!     placeholder for Task 7 and is never produced in T5a.
//!   * [`capture_gdi`] implements [`CaptureBackend`] using GDI bitblt into a
//!     32-bit top-down DIB. This is the only path wired up before the Direct2D
//!     capture path lands.
//!
//! The overlay window, the input state machine, the Direct2D draw path, and the
//! clipboard / encoder wiring live in T5b, T5c, and Task 6 respectively.

#![cfg(windows)]

pub mod capture;
pub mod capture_gdi;
pub mod display;
pub mod renderer;
pub mod window;
