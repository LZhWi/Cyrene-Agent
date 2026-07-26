#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectI {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayRotation {
    Identity,
    Rotate90,
    Rotate180,
    Rotate270,
}

pub fn rotate_rect_to_display(
    rect: RectI,
    source_width: u32,
    source_height: u32,
    rotation: DisplayRotation,
) -> Option<RectI> {
    let source = clamp_to_size(rect, source_width, source_height)?;
    let source_right = i64::from(source.x) + i64::from(source.width);
    let source_bottom = i64::from(source.y) + i64::from(source.height);
    let source_width = i64::from(source_width);
    let source_height = i64::from(source_height);

    let (rotated, display_width, display_height) = match rotation {
        DisplayRotation::Identity => (source, source_width, source_height),
        DisplayRotation::Rotate90 => (
            rect_from_i64(
                source_height - source_bottom,
                i64::from(source.x),
                i64::from(source.height),
                i64::from(source.width),
            )?,
            source_height,
            source_width,
        ),
        DisplayRotation::Rotate180 => (
            rect_from_i64(
                source_width - source_right,
                source_height - source_bottom,
                i64::from(source.width),
                i64::from(source.height),
            )?,
            source_width,
            source_height,
        ),
        DisplayRotation::Rotate270 => (
            rect_from_i64(
                i64::from(source.y),
                source_width - source_right,
                i64::from(source.height),
                i64::from(source.width),
            )?,
            source_height,
            source_width,
        ),
    };

    let clamped = clamp_to_size(
        rotated,
        u32::try_from(display_width).ok()?,
        u32::try_from(display_height).ok()?,
    )?;
    if clamped.width < 4 || clamped.height < 4 {
        return None;
    }

    Some(clamped)
}

pub fn place_toolbar(
    selection: RectI,
    display: RectI,
    toolbar_width: u32,
    toolbar_height: u32,
    gap: u32,
) -> Option<RectI> {
    if display.width == 0
        || display.height == 0
        || toolbar_width > display.width
        || toolbar_height > display.height
    {
        return None;
    }

    let selection = clamp_to_rect(selection, display)?;
    let display_left = i64::from(display.x);
    let display_top = i64::from(display.y);
    let display_right = display_left + i64::from(display.width);
    let display_bottom = display_top + i64::from(display.height);
    let toolbar_width = i64::from(toolbar_width);
    let toolbar_height = i64::from(toolbar_height);
    let gap = i64::from(gap);

    let desired_x =
        i64::from(selection.x) + (i64::from(selection.width) - toolbar_width).div_euclid(2);
    let x = clamp_i64(
        desired_x,
        display_left,
        (display_right - toolbar_width).min(i64::from(i32::MAX)),
    );
    let selection_top = i64::from(selection.y);
    let selection_bottom = selection_top + i64::from(selection.height);
    let y = if selection_bottom + gap + toolbar_height <= display_bottom {
        selection_bottom + gap
    } else if selection_top - gap - toolbar_height >= display_top {
        selection_top - gap - toolbar_height
    } else {
        clamp_i64(
            selection_bottom - toolbar_height,
            display_top,
            (display_bottom - toolbar_height).min(i64::from(i32::MAX)),
        )
    };

    rect_from_i64(x, y, toolbar_width, toolbar_height)
}

fn clamp_to_size(rect: RectI, width: u32, height: u32) -> Option<RectI> {
    if width == 0 || height == 0 {
        return None;
    }

    clamp_to_bounds(rect, 0, 0, i64::from(width), i64::from(height))
}

fn clamp_to_rect(rect: RectI, bounds: RectI) -> Option<RectI> {
    if bounds.width == 0 || bounds.height == 0 {
        return None;
    }

    let left = i64::from(bounds.x);
    let top = i64::from(bounds.y);
    clamp_to_bounds(
        rect,
        left,
        top,
        left + i64::from(bounds.width),
        top + i64::from(bounds.height),
    )
}

fn clamp_to_bounds(
    rect: RectI,
    bound_left: i64,
    bound_top: i64,
    bound_right: i64,
    bound_bottom: i64,
) -> Option<RectI> {
    let rect_left = i64::from(rect.x);
    let rect_top = i64::from(rect.y);
    let left = rect_left.max(bound_left);
    let top = rect_top.max(bound_top);
    let right = (rect_left + i64::from(rect.width)).min(bound_right);
    let bottom = (rect_top + i64::from(rect.height)).min(bound_bottom);

    if left >= right || top >= bottom {
        return None;
    }

    rect_from_i64(left, top, right - left, bottom - top)
}

fn rect_from_i64(x: i64, y: i64, width: i64, height: i64) -> Option<RectI> {
    Some(RectI {
        x: i32::try_from(x).ok()?,
        y: i32::try_from(y).ok()?,
        width: u32::try_from(width).ok()?,
        height: u32::try_from(height).ok()?,
    })
}

fn clamp_i64(value: i64, lower: i64, upper: i64) -> i64 {
    value.clamp(lower, upper)
}
