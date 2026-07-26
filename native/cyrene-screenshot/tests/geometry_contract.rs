use cyrene_screenshot::geometry::{DisplayRotation, RectI, place_toolbar, rotate_rect_to_display};

#[test]
fn identity_rotation_preserves_an_in_bounds_rectangle() {
    let rotated = rotate_rect_to_display(
        RectI {
            x: 10,
            y: 5,
            width: 20,
            height: 30,
        },
        100,
        60,
        DisplayRotation::Identity,
    );

    assert_eq!(
        rotated,
        Some(RectI {
            x: 10,
            y: 5,
            width: 20,
            height: 30,
        })
    );
}

#[test]
fn right_angle_rotations_swap_texture_dimensions() {
    let rect = RectI {
        x: 10,
        y: 5,
        width: 20,
        height: 30,
    };

    assert_eq!(
        rotate_rect_to_display(rect, 100, 60, DisplayRotation::Rotate90),
        Some(RectI {
            x: 25,
            y: 10,
            width: 30,
            height: 20,
        })
    );
    assert_eq!(
        rotate_rect_to_display(rect, 100, 60, DisplayRotation::Rotate270),
        Some(RectI {
            x: 5,
            y: 70,
            width: 30,
            height: 20,
        })
    );
}

#[test]
fn rotation_clamps_negative_input_to_display_bounds() {
    let rotated = rotate_rect_to_display(
        RectI {
            x: -5,
            y: -10,
            width: 20,
            height: 20,
        },
        100,
        50,
        DisplayRotation::Rotate90,
    );

    assert_eq!(
        rotated,
        Some(RectI {
            x: 40,
            y: 0,
            width: 10,
            height: 15,
        })
    );
}

#[test]
fn rotation_rejects_clamped_selections_smaller_than_four_pixels() {
    assert_eq!(
        rotate_rect_to_display(
            RectI {
                x: 98,
                y: 10,
                width: 10,
                height: 10,
            },
            100,
            60,
            DisplayRotation::Rotate180,
        ),
        None
    );
}

#[test]
fn toolbar_moves_above_when_below_does_not_fit() {
    let toolbar = place_toolbar(
        RectI {
            x: 20,
            y: 70,
            width: 30,
            height: 20,
        },
        RectI {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        },
        40,
        10,
        5,
    );

    assert_eq!(
        toolbar,
        Some(RectI {
            x: 15,
            y: 55,
            width: 40,
            height: 10,
        })
    );
}

#[test]
fn toolbar_moves_inside_when_neither_outside_position_fits() {
    let toolbar = place_toolbar(
        RectI {
            x: 20,
            y: 10,
            width: 40,
            height: 80,
        },
        RectI {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        },
        60,
        10,
        5,
    );

    assert_eq!(
        toolbar,
        Some(RectI {
            x: 10,
            y: 80,
            width: 60,
            height: 10,
        })
    );
}

#[test]
fn toolbar_rejects_empty_or_too_small_displays() {
    assert_eq!(
        place_toolbar(
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            RectI {
                x: 0,
                y: 0,
                width: 0,
                height: 20,
            },
            10,
            10,
            2,
        ),
        None
    );
    assert_eq!(
        place_toolbar(
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            RectI {
                x: 0,
                y: 0,
                width: 20,
                height: 20,
            },
            21,
            10,
            2,
        ),
        None
    );
}
