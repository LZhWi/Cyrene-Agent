//! T5b GDI-only overlay renderer. Direct2D is intentionally deferred.

use windows::Win32::{
    Foundation::RECT,
    Graphics::Gdi::{
        CreatePen, CreateSolidBrush, DeleteObject, FillRect, HDC, HGDIOBJ, HPEN, PS_SOLID,
        Rectangle, SelectObject,
    },
};

use crate::{error::HelperError, geometry::RectI, win::display::DisplayInfo};

use super::window::OverlayWindow;

pub fn paint(
    overlay: &OverlayWindow,
    selection: Option<RectI>,
    display: &DisplayInfo,
) -> Result<(), HelperError> {
    let hdc = unsafe { windows::Win32::Graphics::Gdi::GetDC(Some(overlay.hwnd())) };
    if hdc.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let result = paint_hdc(hdc, selection, display);
    let _ = unsafe { windows::Win32::Graphics::Gdi::ReleaseDC(Some(overlay.hwnd()), hdc) };
    result
}

pub(crate) fn paint_hdc(
    hdc: HDC,
    selection: Option<RectI>,
    display: &DisplayInfo,
) -> Result<(), HelperError> {
    let brush = unsafe { CreateSolidBrush(windows::Win32::Foundation::COLORREF(0x00303030)) };
    if brush.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let bounds = RECT {
        left: 0,
        top: 0,
        right: i32::try_from(display.bounds.width)
            .map_err(|_| HelperError::InvalidDisplay("paint width does not fit i32".into()))?,
        bottom: i32::try_from(display.bounds.height)
            .map_err(|_| HelperError::InvalidDisplay("paint height does not fit i32".into()))?,
    };
    unsafe { FillRect(hdc, &bounds, brush) };
    let _ = unsafe { DeleteObject(HGDIOBJ(brush.0)) };

    if let Some(rect) = selection {
        let pen: HPEN = unsafe {
            CreatePen(
                PS_SOLID,
                2,
                windows::Win32::Foundation::COLORREF(0x0000ffff),
            )
        };
        if !pen.is_invalid() {
            let old = unsafe { SelectObject(hdc, HGDIOBJ(pen.0)) };
            unsafe {
                let _ = Rectangle(
                    hdc,
                    rect.x,
                    rect.y,
                    rect.x.saturating_add_unsigned(rect.width),
                    rect.y.saturating_add_unsigned(rect.height),
                );
                let _ = SelectObject(hdc, old);
                let _ = DeleteObject(HGDIOBJ(pen.0));
            }
        }
    }
    Ok(())
}
