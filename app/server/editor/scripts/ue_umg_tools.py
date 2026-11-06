import json


# ---------------------------------------------------------------------------
# UEV UMG authoring operations (design doc section 9.12).
#
# This file renders after the ue_umg prelude, so the compat helpers
# (get_editor_property_value, set_object_property, resolve_class_reference, ...)
# and the UMG helpers (_load_widget_blueprint, get_widget_tree,
# find_widget_in_tree, create_widget_instance, add_widget_to_tree,
# save_widget_blueprint, ...) are all available here.
#
# Contract: every handler returns a JSON-serializable dict with "success".
# Missing engine APIs return success:false plus a machine-readable reason.
# Slot properties that the resolved slot class does not support are reported in
# "warnings" instead of being silently dropped.
# ---------------------------------------------------------------------------

_UMG_ANCHOR_PRESET_TABLE = (
    ("Fill", (0.0, 0.0), (1.0, 1.0)),
    ("TopLeft", (0.0, 0.0), (0.0, 0.0)),
    ("TopCenter", (0.5, 0.0), (0.5, 0.0)),
    ("TopRight", (1.0, 0.0), (1.0, 0.0)),
    ("MiddleLeft", (0.0, 0.5), (0.0, 0.5)),
    ("Center", (0.5, 0.5), (0.5, 0.5)),
    ("MiddleRight", (1.0, 0.5), (1.0, 0.5)),
    ("BottomLeft", (0.0, 1.0), (0.0, 1.0)),
    ("BottomCenter", (0.5, 1.0), (0.5, 1.0)),
    ("BottomRight", (1.0, 1.0), (1.0, 1.0)),
    ("StretchHorizontal", (0.0, 0.5), (1.0, 0.5)),
    ("StretchVertical", (0.5, 0.0), (0.5, 1.0)),
)

_UMG_PANEL_TYPE_TABLE = (
    ("HorizontalBox", "HorizontalBox"),
    ("VerticalBox", "VerticalBox"),
    ("Overlay", "Overlay"),
    ("SizeBox", "SizeBox"),
    ("ScrollBox", "ScrollBox"),
    ("Border", "Border"),
    ("GridPanel", "GridPanel"),
    ("CanvasPanel", "CanvasPanel"),
)

_UMG_ALIGNMENT_MEMBERS = {
    "horizontal": {
        "fill": "FILL",
        "left": "LEFT",
        "center": "CENTER",
        "centre": "CENTER",
        "right": "RIGHT",
    },
    "vertical": {
        "fill": "FILL",
        "top": "TOP",
        "center": "CENTER",
        "centre": "CENTER",
        "bottom": "BOTTOM",
    },
}

_UMG_KNOWN_EVENTS = {
    "button": ("OnClicked", "OnPressed", "OnReleased", "OnHovered", "OnUnhovered"),
    "checkbox": ("OnCheckStateChanged",),
    "editabletext": ("OnTextChanged", "OnTextCommitted"),
    "editabletextbox": ("OnTextChanged", "OnTextCommitted"),
    "multilineeditabletext": ("OnTextChanged", "OnTextCommitted"),
    "multilineeditabletextbox": ("OnTextChanged", "OnTextCommitted"),
    "slider": ("OnValueChanged",),
    "comboboxstring": ("OnSelectionChanged",),
    "spinbox": ("OnValueChanged",),
}

_UMG_PROPERTY_GROUPS = {
    "widget": {
        "visibility": {
            "kind": "enum",
            "enum": "SlateVisibility",
            "method": "set_visibility",
            "property": "visibility",
            "aliases": {
                "collapsed": "COLLAPSED",
                "hidden": "HIDDEN",
                "hittestinvisible": "HIT_TEST_INVISIBLE",
                "selfhittestinvisible": "SELF_HIT_TEST_INVISIBLE",
                "visible": "VISIBLE",
            },
        },
        "is_enabled": {
            "kind": "bool",
            "method": "set_is_enabled",
            "property": "is_enabled",
        },
        "tooltip_text": {
            "kind": "text",
            "method": "set_tool_tip_text",
            "property": "tooltip_text",
        },
        "render_opacity": {
            "kind": "number",
            "method": "set_render_opacity",
            "property": "render_opacity",
        },
        "clipping": {"kind": "enum", "enum": "WidgetClipping", "property": "clipping"},
        "cursor": {"kind": "enum", "enum": "MouseCursor", "property": "cursor"},
    },
    "textblock": {
        "text": {"kind": "text", "method": "set_text", "property": "text"},
        "font_size": {"kind": "font_size"},
        "color": {"kind": "color"},
        "justify": {"kind": "enum", "enum": "TextJustify", "property": "justify"},
        "auto_wrap_text": {"kind": "bool", "property": "auto_wrap_text"},
        "wrap_text_at": {"kind": "number", "property": "wrap_text_at"},
    },
    "richtextblock": {
        "text": {"kind": "text", "method": "set_text", "property": "text"},
        "color": {"kind": "color"},
        "auto_wrap_text": {"kind": "bool", "property": "auto_wrap_text"},
    },
    "editabletext": {
        "text": {"kind": "text", "property": "text"},
        "font_size": {"kind": "font_size"},
        "color": {"kind": "color"},
        "hint_text": {"kind": "text", "property": "hint_text"},
        "is_read_only": {"kind": "bool", "property": "is_read_only"},
        "justify": {"kind": "enum", "enum": "TextJustify", "property": "justify"},
    },
    "button": {
        "background_color": {"kind": "background_color"},
        "color_and_opacity": {"kind": "color"},
        "is_focusable": {"kind": "bool", "property": "is_focusable"},
    },
    "checkbox": {
        "is_checked": {"kind": "bool", "method": "set_is_checked", "property": "is_checked"},
    },
    "slider": {
        "value": {"kind": "number", "method": "set_value", "property": "value"},
        "min_value": {"kind": "number", "method": "set_min_value", "property": "min_value"},
        "max_value": {"kind": "number", "method": "set_max_value", "property": "max_value"},
        "step_size": {"kind": "number", "method": "set_step_size", "property": "step_size"},
        "orientation": {"kind": "enum", "enum": "Orientation", "property": "orientation"},
    },
    "progressbar": {
        "percent": {"kind": "number", "method": "set_percent", "property": "percent"},
        "is_marquee": {"kind": "bool", "property": "is_marquee"},
        "fill_color_and_opacity": {
            "kind": "slate_color",
            "property": "fill_color_and_opacity",
        },
    },
    "image": {"color_and_opacity": {"kind": "color"}},
    "border": {"brush_color": {"kind": "background_color"}},
}

_UMG_PROPERTY_GROUPS["editabletextbox"] = _UMG_PROPERTY_GROUPS["editabletext"]
_UMG_PROPERTY_GROUPS["multilineeditabletext"] = _UMG_PROPERTY_GROUPS["editabletext"]
_UMG_PROPERTY_GROUPS["multilineeditabletextbox"] = _UMG_PROPERTY_GROUPS["editabletext"]


def _umg_normalize_token(value):
    return "".join(
        character for character in str(value or "").strip().lower() if character.isalnum()
    )


def _umg_number(value, field_name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("{0} must be a number.".format(field_name))
    return float(value)


def _umg_vector2(value, field_name="vector2"):
    if isinstance(value, dict):
        return unreal.Vector2D(
            x=_umg_number(value.get("x", 0.0), "{0}.x".format(field_name)),
            y=_umg_number(value.get("y", 0.0), "{0}.y".format(field_name)),
        )

    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return unreal.Vector2D(
            x=_umg_number(value[0], "{0}[0]".format(field_name)),
            y=_umg_number(value[1], "{0}[1]".format(field_name)),
        )

    raise ValueError(
        "{0} must be a vector2: [x, y] or {{x, y}}.".format(field_name)
    )


def _umg_vector2_record(vector):
    return {"x": float(vector.x), "y": float(vector.y)}


def _umg_color_values(value):
    if isinstance(value, dict):
        if all(key in value for key in ("r", "g", "b")):
            return [
                _umg_number(value["r"], "color.r"),
                _umg_number(value["g"], "color.g"),
                _umg_number(value["b"], "color.b"),
                _umg_number(value.get("a", 1.0), "color.a"),
            ]
    elif isinstance(value, (list, tuple)) and 3 <= len(value) <= 4:
        return [_umg_number(entry, "color[{0}]".format(index)) for index, entry in enumerate(value)]

    raise ValueError(
        "color must be [r, g, b], [r, g, b, a], or {{r, g, b, a}} with numbers in 0..1."
    )


def _umg_margin_from_values(values):
    margin = unreal.Margin()
    margin_values = {}
    defaulted = []
    for key in ("left", "top", "right", "bottom"):
        raw_value = values.get(key)
        if raw_value is None:
            raw_value = 0.0
            defaulted.append(key)

        margin_values[key] = _umg_number(raw_value, key)
        if not set_object_property(margin, key, margin_values[key]):
            raise ValueError("Failed to set margin {0}.".format(key))

    return margin, margin_values, defaulted


def _umg_padding_margin(padding):
    if isinstance(padding, dict):
        return _umg_margin_from_values(padding)

    if isinstance(padding, (list, tuple)):
        if len(padding) == 1:
            return _umg_margin_from_values(
                {"left": padding[0], "top": padding[0], "right": padding[0], "bottom": padding[0]}
            )
        if len(padding) == 2:
            return _umg_margin_from_values(
                {"left": padding[0], "top": padding[1], "right": padding[0], "bottom": padding[1]}
            )
        if len(padding) == 4:
            return _umg_margin_from_values(
                {"left": padding[0], "top": padding[1], "right": padding[2], "bottom": padding[3]}
            )

    raise ValueError(
        "padding must be {{left, top, right, bottom}} or a 1, 2, or 4 element array."
    )


def _umg_anchor_presets():
    presets = {}
    for label, minimum, maximum in _UMG_ANCHOR_PRESET_TABLE:
        presets[_umg_normalize_token(label)] = (minimum, maximum)
    return presets


def _umg_anchor_preset_labels():
    return [entry[0] for entry in _UMG_ANCHOR_PRESET_TABLE]


def _umg_panel_class_map():
    return dict((_umg_normalize_token(label), class_name) for label, class_name in _UMG_PANEL_TYPE_TABLE)


def _umg_panel_type_labels():
    return [entry[0] for entry in _UMG_PANEL_TYPE_TABLE]


def _umg_target_name(args):
    return (
        args.get("target_widget_name")
        or args.get("widget_member_name")
        or args.get("widget_component_name")
    )


def _umg_load_target(args):
    widget_blueprint = _load_widget_blueprint(args.get("widget_name"))
    widget_tree = get_widget_tree(widget_blueprint)
    target_name = _umg_target_name(args)
    if not target_name:
        raise ValueError(
            "widget_name is required: pass the widget inside the blueprint. The blueprint asset is selected with widget_blueprint_path."
        )

    target_widget = find_widget_in_tree(widget_tree, target_name)
    if not target_widget:
        raise ValueError(
            "Widget '{0}' was not found in widget blueprint '{1}'.".format(
                target_name, get_asset_package_name(widget_blueprint)
            )
        )

    return widget_blueprint, widget_tree, target_widget


def _umg_slot_of(widget):
    return get_editor_property_value(widget, "slot")


def _umg_slot_class_name(slot):
    if not slot:
        return None
    return get_object_class_name(slot)


def _umg_slot_capability_error(widget, slot, capability, hint):
    return {
        "success": False,
        "reason": "unsupported_slot_class",
        "message": "Widget '{0}' uses slot class '{1}', which does not support {2} in this engine version. {3}".format(
            get_widget_name(widget),
            _umg_slot_class_name(slot) or "none",
            capability,
            hint,
        ),
        "widget": get_widget_name(widget),
        "slot_class": _umg_slot_class_name(slot),
        "unsupported_capability": capability,
    }


def _umg_slot_supports(slot, method_name):
    return bool(slot) and callable(getattr(slot, method_name, None))


def _umg_widget_result(widget_blueprint, target_widget, action_name):
    return {
        "success": True,
        "action": action_name,
        "widget_blueprint": get_asset_package_name(widget_blueprint),
        "widget": get_widget_name(target_widget),
        "widget_class": get_widget_class_name(target_widget),
    }


def _umg_enum_member_names(enum_type):
    try:
        return [name for name in dir(enum_type) if not name.startswith("_")]
    except Exception:
        return []


def _umg_enum_member(enum_type, value, aliases=None, label=None):
    type_label = label or getattr(enum_type, "__name__", "enum")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Expected an enum name string for {0}.".format(type_label))

    normalized = _umg_normalize_token(value)
    candidates = {}
    for member_name in _umg_enum_member_names(enum_type):
        member_value = getattr(enum_type, member_name, None)
        if member_value is not None:
            candidates[_umg_normalize_token(member_name)] = member_value

    if normalized in candidates:
        return candidates[normalized]

    alias_target = (aliases or {}).get(normalized)
    if alias_target and _umg_normalize_token(alias_target) in candidates:
        return candidates[_umg_normalize_token(alias_target)]

    if not candidates:
        direct_member = getattr(enum_type, str(value).strip().upper(), None)
        if direct_member is not None:
            return direct_member
        raise ValueError(
            "Enum {0} is not introspectable in this engine version; cannot resolve '{1}'.".format(
                type_label, value
            )
        )

    raise ValueError(
        "Unsupported value '{0}' for {1}. Supported values: {2}.".format(
            value, type_label, ", ".join(sorted(candidates.keys()))
        )
    )


def _umg_alignment_member(axis, value):
    if not isinstance(value, str):
        raise ValueError("{0}_alignment must be a string.".format(axis))

    member_name = _UMG_ALIGNMENT_MEMBERS.get(axis, {}).get(_umg_normalize_token(value))
    if not member_name:
        raise ValueError(
            "Unsupported {0} alignment '{1}'. Horizontal accepts fill/left/center/right; vertical accepts fill/top/center/bottom.".format(
                axis, value
            )
        )

    enum_type = getattr(
        unreal, "HorizontalAlignment" if axis == "horizontal" else "VerticalAlignment", None
    )
    if enum_type is None:
        raise ValueError(
            "unreal.{0}Alignment is not exposed in this engine version.".format(
                "Horizontal" if axis == "horizontal" else "Vertical"
            )
        )

    member = getattr(enum_type, member_name, None)
    if member is None:
        raise ValueError(
            "{0}Alignment.{1} is not exposed in this engine version.".format(
                "Horizontal" if axis == "horizontal" else "Vertical", member_name
            )
        )

    return member, member_name.lower()


def _umg_slate_child_size(mode):
    normalized = _umg_normalize_token(mode)
    if normalized in ("fill", "fillsize"):
        rule_name = "FILL"
        label = "fill"
    elif normalized in ("auto", "automatic", "autosize"):
        rule_name = "AUTOMATIC"
        label = "auto"
    else:
        raise ValueError("size must be a vector2 or 'fill'/'auto'.")

    size_type = getattr(unreal, "SlateChildSize", None)
    if size_type is None:
        raise ValueError(
            "unreal.SlateChildSize is not exposed in this engine version, so fill/auto slot sizing cannot be applied."
        )

    rule_type = getattr(unreal, "SlateSizeRule", None) or getattr(unreal, "SizeRule", None)
    rule_member = getattr(rule_type, rule_name, None) if rule_type is not None else None
    if rule_member is None:
        raise ValueError(
            "SlateSizeRule.{0} is not exposed in this engine version, so fill/auto slot sizing cannot be applied.".format(
                rule_name
            )
        )

    child_size = size_type()
    if not set_object_property(child_size, "value", 1.0):
        raise ValueError("Failed to set SlateChildSize value.")
    if not set_object_property(child_size, "size_rule", rule_member):
        raise ValueError("Failed to set SlateChildSize size_rule.")

    return child_size, label


def _umg_call_or_set(target, method_name, property_name, value):
    if method_name:
        method = getattr(target, method_name, None)
        if callable(method):
            method(value)
            return True

    if property_name and set_object_property(target, property_name, value):
        return True

    raise ValueError(
        "Widget '{0}' does not expose a writable '{1}' in this engine version.".format(
            get_widget_name(target), property_name or method_name
        )
    )


def _umg_set_text_property(widget, property_name, value, method_name=None):
    if method_name:
        method = getattr(widget, method_name, None)
        if callable(method):
            try:
                method(value)
                return True
            except Exception:
                pass

    if set_widget_text(widget, value):
        return True

    if property_name and set_object_property(widget, property_name, value):
        return True

    raise ValueError(
        "Widget '{0}' does not expose a writable text property.".format(
            get_widget_name(widget)
        )
    )


def _umg_apply_widget_property(widget, spec, value):
    kind = spec.get("kind")

    if kind == "bool":
        if not isinstance(value, bool):
            raise ValueError("This property requires true or false.")
        return _umg_call_or_set(widget, spec.get("method"), spec.get("property"), value)

    if kind == "number":
        return _umg_call_or_set(
            widget, spec.get("method"), spec.get("property"), _umg_number(value, "value")
        )

    if kind == "text":
        if not isinstance(value, str):
            raise ValueError("This property requires a string.")
        return _umg_set_text_property(
            widget, spec.get("property"), value, spec.get("method")
        )

    if kind == "font_size":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("font_size requires a number.")
        if not set_widget_font_size(widget, int(value)):
            raise ValueError(
                "Widget '{0}' does not expose a writable font size.".format(
                    get_widget_name(widget)
                )
            )
        return True

    if kind == "color":
        return apply_widget_color(widget, _umg_color_values(value), role="foreground")

    if kind == "background_color":
        return apply_widget_color(widget, _umg_color_values(value), role="background")

    if kind == "slate_color":
        slate_color = as_slate_color(_umg_color_values(value))
        if slate_color is None:
            raise ValueError("Could not build a SlateColor in this engine version.")
        if not set_object_property(widget, spec.get("property"), slate_color):
            raise ValueError(
                "Widget '{0}' does not expose a writable '{1}'.".format(
                    get_widget_name(widget), spec.get("property")
                )
            )
        return True

    if kind == "enum":
        enum_name = spec.get("enum")
        enum_type = getattr(unreal, enum_name, None)
        if enum_type is None:
            raise ValueError(
                "unreal.{0} is not exposed in this engine version.".format(enum_name)
            )
        member = _umg_enum_member(enum_type, value, spec.get("aliases"), enum_name)
        return _umg_call_or_set(widget, spec.get("method"), spec.get("property"), member)

    raise ValueError("Unsupported property kind: {0}".format(kind))


def _umg_widget_class_names(widget):
    class_names = []
    class_object = None
    try:
        class_object = widget.get_class()
    except Exception:
        class_object = None

    visited = 0
    while class_object and visited < 32:
        class_names.append(_umg_normalize_token(get_object_name(class_object)))
        class_object = get_super_UClass(class_object)
        visited += 1

    if not class_names:
        class_names.append(_umg_normalize_token(get_widget_class_name(widget)))

    return class_names


def _umg_property_whitelist(widget):
    allowed = {}
    class_names = _umg_widget_class_names(widget)
    for group_name, group in _UMG_PROPERTY_GROUPS.items():
        if group_name != "widget" and group_name not in class_names:
            continue
        for property_name, spec in group.items():
            allowed[property_name] = spec

    return allowed


def _umg_scan_delegate_attributes(target_widget):
    event_names = []
    try:
        attribute_names = list(dir(target_widget))
    except Exception:
        return event_names

    for attribute_name in attribute_names:
        if not attribute_name.startswith("on_"):
            continue
        try:
            attribute_value = getattr(target_widget, attribute_name)
        except Exception:
            continue
        if callable(attribute_value):
            continue
        parts = [part for part in attribute_name[3:].split("_") if part]
        if not parts:
            continue
        event_names.append("On" + "".join(part[:1].upper() + part[1:] for part in parts))

    return event_names


# ---------------------------------------------------------------------------
# Slot and layout operations (manage_widget.set_anchors / set_alignment /
# set_offsets / set_size / set_padding / set_slot / add_panel).
# ---------------------------------------------------------------------------


def set_widget_anchors(args):
    preset_name = args.get("anchor_preset") or args.get("preset")
    minimum = args.get("minimum")
    maximum = args.get("maximum")

    presets = _umg_anchor_presets()
    if not preset_name:
        if minimum is None or maximum is None:
            return {
                "success": False,
                "message": "Provide anchor_preset (or preset) or both minimum and maximum anchors. Supported presets: {0}.".format(
                    ", ".join(_umg_anchor_preset_labels())
                ),
            }
        normalized_preset = "custom"
    else:
        normalized_preset = _umg_normalize_token(preset_name)

    if normalized_preset == "custom":
        if minimum is None or maximum is None:
            return {
                "success": False,
                "message": "anchor_preset Custom requires minimum and maximum anchors.",
            }
    elif normalized_preset not in presets:
        return {
            "success": False,
            "message": "Unknown anchor preset '{0}'. Supported presets: {1}.".format(
                preset_name, ", ".join(_umg_anchor_preset_labels())
            ),
        }

    pie_error = require_editor_not_in_play("set_anchors")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not object_is_instance_of(slot, unreal.CanvasPanelSlot):
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "anchors",
                "Anchors require a CanvasPanel parent; use manage_widget.add_child_widget with parent CanvasPanel.",
            )

        if normalized_preset == "custom":
            minimum_values = _umg_vector2(minimum, "minimum")
            maximum_values = _umg_vector2(maximum, "maximum")
            preset_label = "Custom"
        else:
            preset_values = presets[normalized_preset]
            minimum_values = unreal.Vector2D(x=preset_values[0][0], y=preset_values[0][1])
            maximum_values = unreal.Vector2D(x=preset_values[1][0], y=preset_values[1][1])
            preset_label = preset_name

        anchors = unreal.Anchors()
        if not set_object_property(anchors, "minimum", minimum_values):
            raise ValueError("Failed to set anchor minimum.")
        if not set_object_property(anchors, "maximum", maximum_values):
            raise ValueError("Failed to set anchor maximum.")
        if not _umg_slot_supports(slot, "set_anchors"):
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "anchors",
                "CanvasPanelSlot.set_anchors is not exposed in this engine version.",
            )

        slot.set_anchors(anchors)
        saved = save_widget_blueprint(widget_blueprint)

        result = _umg_widget_result(widget_blueprint, target_widget, "set_anchors")
        result.update(
            {
                "slot_class": _umg_slot_class_name(slot),
                "anchor_preset": preset_label,
                "anchors": {
                    "minimum": _umg_vector2_record(minimum_values),
                    "maximum": _umg_vector2_record(maximum_values),
                },
                "saved": bool(saved),
            }
        )
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def set_widget_alignment(args):
    alignment = args.get("alignment")
    if alignment is None:
        return {"success": False, "message": "alignment (vector2) is required."}

    pie_error = require_editor_not_in_play("set_alignment")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not slot:
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "alignment",
                "The root widget has no slot; wrap it with manage_widget.ensure_canvas_root.",
            )

        alignment_vector = _umg_vector2(alignment, "alignment")
        applied = {}
        warnings = []

        if object_is_instance_of(slot, unreal.CanvasPanelSlot):
            if not _umg_slot_supports(slot, "set_alignment"):
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "alignment",
                    "CanvasPanelSlot.set_alignment is not exposed in this engine version.",
                )
            slot.set_alignment(alignment_vector)
            applied["alignment"] = _umg_vector2_record(alignment_vector)
        else:
            horizontal_supported = _umg_slot_supports(slot, "set_horizontal_alignment")
            vertical_supported = _umg_slot_supports(slot, "set_vertical_alignment")
            if not horizontal_supported and not vertical_supported:
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "alignment",
                    "Use manage_widget.set_slot for slot classes without alignment setters.",
                )

            horizontal_label, horizontal_exact = _umg_nearest_alignment(
                alignment_vector.x, "horizontal"
            )
            vertical_label, vertical_exact = _umg_nearest_alignment(
                alignment_vector.y, "vertical"
            )
            if horizontal_supported:
                member, label = _umg_alignment_member("horizontal", horizontal_label)
                slot.set_horizontal_alignment(member)
                applied["horizontal_alignment"] = label
                if not horizontal_exact:
                    warnings.append(
                        "alignment.x {0} snapped to '{1}' because slots only support discrete alignments.".format(
                            alignment_vector.x, label
                        )
                    )
            if vertical_supported:
                member, label = _umg_alignment_member("vertical", vertical_label)
                slot.set_vertical_alignment(member)
                applied["vertical_alignment"] = label
                if not vertical_exact:
                    warnings.append(
                        "alignment.y {0} snapped to '{1}' because slots only support discrete alignments.".format(
                            alignment_vector.y, label
                        )
                    )

        saved = save_widget_blueprint(widget_blueprint)
        result = _umg_widget_result(widget_blueprint, target_widget, "set_alignment")
        result.update(
            {
                "slot_class": _umg_slot_class_name(slot),
                "applied": applied,
                "warnings": warnings,
                "saved": bool(saved),
            }
        )
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def _umg_nearest_alignment(ratio, axis):
    if ratio <= 0.25:
        label = "left" if axis == "horizontal" else "top"
        exact = abs(ratio) < 0.001
    elif ratio >= 0.75:
        label = "right" if axis == "horizontal" else "bottom"
        exact = abs(ratio - 1.0) < 0.001
    else:
        label = "center"
        exact = abs(ratio - 0.5) < 0.001

    return label, exact


def set_widget_offsets(args):
    has_offset_edge = any(
        args.get(key) is not None for key in ("left", "top", "right", "bottom")
    )
    position = args.get("position")
    size = args.get("size")

    if not has_offset_edge and position is None and size is None:
        return {
            "success": False,
            "message": "Provide left/top/right/bottom offsets or position and/or size.",
        }

    pie_error = require_editor_not_in_play("set_offsets")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not object_is_instance_of(slot, unreal.CanvasPanelSlot):
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "offsets",
                "Offsets require a CanvasPanel parent; use manage_widget.set_padding for padding-based slots.",
            )

        warnings = []
        result = _umg_widget_result(widget_blueprint, target_widget, "set_offsets")
        result["slot_class"] = _umg_slot_class_name(slot)

        if position is not None or size is not None:
            position_vector = _umg_vector2(position, "position") if position is not None else None
            size_vector = _umg_vector2(size, "size") if size is not None else None
            set_canvas_panel_slot_layout(
                slot,
                _umg_vector2_record(position_vector) if position_vector is not None else None,
                _umg_vector2_record(size_vector) if size_vector is not None else None,
                None,
            )
            layout = {}
            if position_vector is not None:
                layout["position"] = _umg_vector2_record(position_vector)
            if size_vector is not None:
                layout["size"] = _umg_vector2_record(size_vector)
            result["layout"] = layout

        if has_offset_edge:
            current_offsets = None
            layout_data = get_editor_property_value(slot, "layout_data")
            if layout_data is not None:
                current_offsets = get_editor_property_value(layout_data, "offsets")

            margin_values = {}
            defaulted = []
            for key in ("left", "top", "right", "bottom"):
                raw_value = args.get(key)
                if raw_value is None and current_offsets is not None:
                    raw_value = get_editor_property_value(current_offsets, key)
                if raw_value is None:
                    raw_value = 0.0
                    defaulted.append(key)
                margin_values[key] = _umg_number(raw_value, key)

            margin = unreal.Margin()
            for key in ("left", "top", "right", "bottom"):
                if not set_object_property(margin, key, margin_values[key]):
                    raise ValueError("Failed to set margin {0}.".format(key))

            if not _umg_slot_supports(slot, "set_offsets"):
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "offsets",
                    "CanvasPanelSlot.set_offsets is not exposed in this engine version.",
                )

            slot.set_offsets(margin)
            result["offsets"] = margin_values
            if defaulted:
                warnings.append(
                    "Offsets not provided were kept from the current slot layout or defaulted to 0: {0}.".format(
                        ", ".join(defaulted)
                    )
                )

        saved = save_widget_blueprint(widget_blueprint)
        result["warnings"] = warnings
        result["saved"] = bool(saved)
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def set_widget_size(args):
    size = args.get("size")
    if size is None:
        return {"success": False, "message": "size is required (vector2 or 'fill'/'auto')."}

    pie_error = require_editor_not_in_play("set_size")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not slot:
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "size",
                "The root widget has no slot; wrap it with manage_widget.ensure_canvas_root.",
            )

        warnings = []
        result = _umg_widget_result(widget_blueprint, target_widget, "set_size")
        result["slot_class"] = _umg_slot_class_name(slot)

        if isinstance(size, str):
            if object_is_instance_of(slot, unreal.CanvasPanelSlot):
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "fill/auto size",
                    "CanvasPanelSlot uses pixel size; pass a vector2 size instead.",
                )
            child_size, size_mode = _umg_slate_child_size(size)
            if not _umg_slot_supports(slot, "set_size"):
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "size {0}".format(size_mode),
                    "This slot class has no size rule.",
                )
            slot.set_size(child_size)
            result["size"] = {"mode": size_mode}
        else:
            if not object_is_instance_of(slot, unreal.CanvasPanelSlot):
                return _umg_slot_capability_error(
                    target_widget,
                    slot,
                    "pixel size",
                    "Pixel sizes require a CanvasPanel parent; use size 'fill' or 'auto' for box slots.",
                )
            size_vector = _umg_vector2(size, "size")
            set_canvas_panel_slot_layout(slot, None, _umg_vector2_record(size_vector), None)
            result["size"] = _umg_vector2_record(size_vector)

        saved = save_widget_blueprint(widget_blueprint)
        result["warnings"] = warnings
        result["saved"] = bool(saved)
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def set_widget_padding(args):
    pie_error = require_editor_not_in_play("set_padding")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not _umg_slot_supports(slot, "set_padding"):
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "padding",
                "CanvasPanelSlot has no padding; use manage_widget.set_offsets for canvas children.",
            )

        margin, margin_values, defaulted = _umg_margin_from_values(args)
        slot.set_padding(margin)
        saved = save_widget_blueprint(widget_blueprint)

        result = _umg_widget_result(widget_blueprint, target_widget, "set_padding")
        result.update(
            {
                "slot_class": _umg_slot_class_name(slot),
                "padding": margin_values,
                "saved": bool(saved),
            }
        )
        if defaulted:
            result["warnings"] = [
                "Padding edges not provided were set to 0: {0}.".format(", ".join(defaulted))
            ]

        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def add_panel_to_widget(args):
    panel_type = args.get("panel_type")
    panel_name = args.get("panel_name") or args.get("name")
    if not panel_type:
        return {
            "success": False,
            "message": "panel_type is required. Supported types: {0}.".format(
                ", ".join(_umg_panel_type_labels())
            ),
        }

    panel_class_name = _umg_panel_class_map().get(_umg_normalize_token(panel_type))
    if not panel_class_name:
        return {
            "success": False,
            "message": "Unsupported panel_type '{0}'. Supported types: {1}.".format(
                panel_type, ", ".join(_umg_panel_type_labels())
            ),
        }

    if not panel_name:
        return {"success": False, "message": "panel_name is required."}

    if not hasattr(unreal, panel_class_name):
        return {
            "success": False,
            "reason": "unsupported_capability",
            "message": "unreal.{0} is not exposed in this engine version.".format(
                panel_class_name
            ),
            "unsupported_capability": panel_class_name,
        }

    pie_error = require_editor_not_in_play("add_panel")
    if pie_error:
        return pie_error

    try:
        widget_blueprint = _load_widget_blueprint(args.get("widget_name"))
        widget_tree = get_widget_tree(widget_blueprint)

        parent_widget_name = args.get("parent_widget_name")
        if parent_widget_name:
            parent_widget = find_widget_in_tree(widget_tree, parent_widget_name)
            if not parent_widget:
                raise ValueError(
                    "Parent widget '{0}' was not found in widget blueprint '{1}'.".format(
                        parent_widget_name, get_asset_package_name(widget_blueprint)
                    )
                )
        else:
            widget_tree, parent_widget = _ensure_root_canvas(widget_blueprint)

        parent_widget = require_panel_widget(parent_widget, get_widget_name(parent_widget))
        panel_widget = create_widget_instance(widget_tree, panel_class_name, panel_name)
        slot = add_widget_to_tree(widget_tree, panel_widget, parent_widget)

        fill_applied = False
        if slot is not None and object_is_instance_of(slot, unreal.CanvasPanelSlot):
            fill_applied = set_canvas_panel_slot_fill(slot)

        saved = save_widget_blueprint(widget_blueprint)
        result = {
            "success": True,
            "action": "add_panel",
            "widget_blueprint": get_asset_package_name(widget_blueprint),
            "panel": {
                "name": get_widget_name(panel_widget),
                "class": get_widget_class_name(panel_widget),
                "parent": get_widget_name(parent_widget),
            },
            "slot": {
                "slot_class": _umg_slot_class_name(slot),
                "canvas_fill_applied": bool(fill_applied),
            },
            "saved": bool(saved),
        }
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def set_widget_slot(args):
    pie_error = require_editor_not_in_play("set_slot")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        slot = _umg_slot_of(target_widget)
        if not slot:
            return _umg_slot_capability_error(
                target_widget,
                slot,
                "slot properties",
                "The root widget has no slot; wrap it with manage_widget.ensure_canvas_root.",
            )

        slot_class_name = _umg_slot_class_name(slot)
        applied = {}
        warnings = []

        padding = args.get("padding")
        if padding is not None:
            if _umg_slot_supports(slot, "set_padding"):
                margin, margin_values, defaulted = _umg_padding_margin(padding)
                slot.set_padding(margin)
                applied["padding"] = margin_values
                if defaulted:
                    warnings.append(
                        "Padding edges not provided were set to 0: {0}.".format(
                            ", ".join(defaulted)
                        )
                    )
            else:
                warnings.append(
                    "Slot class {0} does not support padding.".format(slot_class_name)
                )

        horizontal_alignment = args.get("horizontal_alignment")
        if horizontal_alignment is not None:
            if _umg_slot_supports(slot, "set_horizontal_alignment"):
                member, label = _umg_alignment_member("horizontal", horizontal_alignment)
                slot.set_horizontal_alignment(member)
                applied["horizontal_alignment"] = label
            else:
                warnings.append(
                    "Slot class {0} does not support horizontal_alignment.".format(
                        slot_class_name
                    )
                )

        vertical_alignment = args.get("vertical_alignment")
        if vertical_alignment is not None:
            if _umg_slot_supports(slot, "set_vertical_alignment"):
                member, label = _umg_alignment_member("vertical", vertical_alignment)
                slot.set_vertical_alignment(member)
                applied["vertical_alignment"] = label
            else:
                warnings.append(
                    "Slot class {0} does not support vertical_alignment.".format(
                        slot_class_name
                    )
                )

        size_mode = args.get("size")
        if size_mode is not None:
            if isinstance(size_mode, str):
                if object_is_instance_of(slot, unreal.CanvasPanelSlot):
                    warnings.append(
                        "CanvasPanelSlot does not support fill/auto size; pass a vector2 size."
                    )
                elif _umg_slot_supports(slot, "set_size"):
                    child_size, size_label = _umg_slate_child_size(size_mode)
                    slot.set_size(child_size)
                    applied["size"] = {"mode": size_label}
                else:
                    warnings.append(
                        "Slot class {0} does not support size fill/auto.".format(
                            slot_class_name
                        )
                    )
            elif object_is_instance_of(slot, unreal.CanvasPanelSlot):
                if _umg_slot_supports(slot, "set_size"):
                    size_vector = _umg_vector2(size_mode, "size")
                    slot.set_size(size_vector)
                    applied["size"] = _umg_vector2_record(size_vector)
                else:
                    warnings.append(
                        "CanvasPanelSlot.set_size is not exposed in this engine version."
                    )
            else:
                warnings.append(
                    "Slot class {0} does not accept pixel sizes; pass size 'fill' or 'auto'.".format(
                        slot_class_name
                    )
                )

        for key, method_name in (
            ("row", "set_row"),
            ("column", "set_column"),
            ("row_span", "set_row_span"),
            ("column_span", "set_column_span"),
        ):
            raw_value = args.get(key)
            if raw_value is None:
                continue
            if _umg_slot_supports(slot, method_name):
                int_value = int(raw_value)
                getattr(slot, method_name)(int_value)
                applied[key] = int_value
            else:
                warnings.append(
                    "Slot class {0} does not support {1}.".format(slot_class_name, key)
                )

        z_order = args.get("z_order")
        if z_order is not None:
            if object_is_instance_of(slot, unreal.CanvasPanelSlot) and _umg_slot_supports(
                slot, "set_z_order"
            ):
                slot.set_z_order(int(z_order))
                applied["z_order"] = int(z_order)
            else:
                warnings.append(
                    "Slot class {0} does not support z_order.".format(slot_class_name)
                )

        if not applied:
            return {
                "success": False,
                "reason": "unsupported_properties",
                "message": "None of the requested slot properties are supported by slot class {0}.".format(
                    slot_class_name
                ),
                "widget": get_widget_name(target_widget),
                "slot_class": slot_class_name,
                "warnings": warnings,
            }

        saved = save_widget_blueprint(widget_blueprint)
        result = _umg_widget_result(widget_blueprint, target_widget, "set_slot")
        result.update(
            {
                "slot_class": slot_class_name,
                "applied": applied,
                "warnings": warnings,
                "saved": bool(saved),
            }
        )
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def set_widget_property_value(args):
    property_name = args.get("property")
    if not property_name:
        return {"success": False, "message": "property is required."}
    if args.get("value") is None:
        return {"success": False, "message": "value is required."}

    pie_error = require_editor_not_in_play("set_widget_property")
    if pie_error:
        return pie_error

    try:
        widget_blueprint, widget_tree, target_widget = _umg_load_target(args)
        allowed = _umg_property_whitelist(target_widget)
        spec = allowed.get(property_name)
        if not spec:
            return {
                "success": False,
                "reason": "unsupported_property",
                "message": "Property '{0}' is not supported for {1}. Supported properties: {2}.".format(
                    property_name,
                    get_widget_class_name(target_widget),
                    ", ".join(sorted(allowed.keys())),
                ),
                "widget": get_widget_name(target_widget),
                "widget_class": get_widget_class_name(target_widget),
                "supported_properties": sorted(allowed.keys()),
            }

        value = args.get("value")
        _umg_apply_widget_property(target_widget, spec, value)
        saved = save_widget_blueprint(widget_blueprint)

        result = _umg_widget_result(widget_blueprint, target_widget, "set_widget_property")
        result.update(
            {
                "property": property_name,
                "value": value,
                "saved": bool(saved),
            }
        )
        return result
    except Exception as exc:
        return _format_widget_authoring_error(exc)


def list_widget_events(args):
    try:
        widget_blueprint = _load_widget_blueprint(args.get("widget_name"))
        widget_tree = get_widget_tree(widget_blueprint)
        target_name = _umg_target_name(args)
        if target_name:
            target_widget = find_widget_in_tree(widget_tree, target_name)
            if not target_widget:
                return {
                    "success": False,
                    "message": "Widget '{0}' was not found in widget blueprint '{1}'.".format(
                        target_name, get_asset_package_name(widget_blueprint)
                    ),
                }
        else:
            target_widget = get_root_widget(widget_tree)
            if not target_widget:
                return {
                    "success": False,
                    "message": "Widget blueprint '{0}' has no root widget.".format(
                        get_asset_package_name(widget_blueprint)
                    ),
                }

        class_names = _umg_widget_class_names(target_widget)
        events = []
        seen_events = set()

        for class_name in class_names:
            for event_name in _UMG_KNOWN_EVENTS.get(class_name, ()):
                if event_name in seen_events:
                    continue
                seen_events.add(event_name)
                events.append({"name": event_name, "source": "known_widget_delegates"})

        for event_name in _umg_scan_delegate_attributes(target_widget):
            if event_name in seen_events:
                continue
            seen_events.add(event_name)
            events.append({"name": event_name, "source": "python_binding"})

        binding_method = None
        if hasattr(unreal, "DelegateEditorBinding"):
            binding_method = "DelegateEditorBinding"
        elif hasattr(unreal, "UEVGraphLibrary"):
            binding_method = "UEVGraphAuthoring"

        warnings = [
            "Delegate names come from a built-in per-widget table plus Python attribute scanning; UE4.27 Python does not expose generic multicast delegate reflection."
        ]
        if not events:
            warnings.append(
                "No delegate events are known for widget class '{0}'.".format(
                    get_widget_class_name(target_widget)
                )
            )
        if binding_method is None:
            warnings.append(
                "bind_event is unavailable: neither DelegateEditorBinding nor UEVGraphLibrary is exposed in this editor session."
            )

        return {
            "success": True,
            "action": "list_events",
            "widget_blueprint": get_asset_package_name(widget_blueprint),
            "widget": get_widget_name(target_widget),
            "widget_class": get_widget_class_name(target_widget),
            "event_count": len(events),
            "events": events,
            "bind_action": "manage_widget.bind_event",
            "supports_binding": binding_method is not None,
            "binding_method": binding_method,
            "warnings": warnings,
        }
    except Exception as exc:
        return _format_widget_authoring_error(exc)


# ---------------------------------------------------------------------------
# Editor tool operations (design doc section 9.13).
# ---------------------------------------------------------------------------


def _umg_editor_utility_name(args):
    return (
        args.get("name")
        or args.get("asset_name")
        or args.get("blueprint_name")
        or args.get("widget_name")
    )


def _umg_create_editor_utility_asset(args, action_name, parent_class_name, required_parent_name):
    asset_name = _umg_editor_utility_name(args)
    if not asset_name:
        return {"success": False, "message": "name is required."}

    content_path = args.get("path") or "/Game/EditorUtilities"

    pie_error = require_editor_not_in_play(action_name)
    if pie_error:
        return pie_error

    asset_class = getattr(unreal, "EditorUtilityBlueprint", None)
    asset_class_fallback = False
    if asset_class is None:
        asset_class = getattr(unreal, "Blueprint", None)
        asset_class_fallback = True
    if asset_class is None:
        return {
            "success": False,
            "reason": "unsupported_capability",
            "message": "Neither unreal.EditorUtilityBlueprint nor unreal.Blueprint is exposed in this engine version; editor utility blueprints cannot be created.",
            "unsupported_capability": "EditorUtilityBlueprint",
        }

    required_parent_class = None
    if required_parent_name:
        required_parent_class = getattr(unreal, required_parent_name, None)
        if required_parent_class is None:
            return {
                "success": False,
                "reason": "unsupported_capability",
                "message": "unreal.{0} is not exposed in this engine version.".format(
                    required_parent_name
                ),
                "unsupported_capability": required_parent_name,
            }

    parent_uclass = None
    warnings = []
    if parent_class_name:
        parent_class = resolve_class_reference(
            parent_class_name, ["Blutility", "UMG", "Engine", "CoreUObject"]
        )
        if not parent_class:
            return {
                "success": False,
                "message": "Editor utility parent class not found: {0}".format(
                    parent_class_name
                ),
            }
        parent_uclass = get_UClass(parent_class)
        if not parent_uclass:
            return {
                "success": False,
                "message": "Could not resolve UClass for editor utility parent class: {0}".format(
                    parent_class_name
                ),
            }
        if required_parent_class and not class_is_child_of(parent_class, required_parent_class):
            return {
                "success": False,
                "message": "parent_class {0} is not a {1} subclass.".format(
                    parent_class_name, required_parent_name
                ),
            }

    preferred_factory_name = None
    if required_parent_name == "ActorActionUtility":
        preferred_factory_name = "ActorActionUtilityFactory"
    elif required_parent_name == "AssetActionUtility":
        preferred_factory_name = "AssetActionUtilityFactory"

    factory_class = None
    if asset_class_fallback:
        if parent_uclass is None:
            return {
                "success": False,
                "reason": "unsupported_capability",
                "message": "This engine version does not expose unreal.EditorUtilityBlueprint. A plain Blueprint fallback needs an explicit parent_class (for example ActorActionUtility or AssetActionUtility).",
                "unsupported_capability": "EditorUtilityBlueprint",
            }
        factory_class = getattr(unreal, "BlueprintFactory", None)
        warnings.append(
            "unreal.EditorUtilityBlueprint is not exposed in this engine version; creating a plain Blueprint with parent_class {0} instead. Editor menus may still discover it by parent class, but the asset type is Blueprint, not EditorUtilityBlueprint.".format(
                required_parent_name or parent_class_name
            )
        )
    else:
        if preferred_factory_name:
            factory_class = getattr(unreal, preferred_factory_name, None)
            if factory_class is None:
                warnings.append(
                    "unreal.{0} is not exposed; falling back to EditorUtilityBlueprintFactory with parent_class {1}.".format(
                        preferred_factory_name, required_parent_name
                    )
                )

        if factory_class is None:
            factory_class = getattr(unreal, "EditorUtilityBlueprintFactory", None)

    if factory_class is None:
        return {
            "success": False,
            "reason": "unsupported_capability",
            "message": "No editor utility blueprint factory is exposed in this engine version; editor utility blueprints cannot be created.",
            "unsupported_capability": "EditorUtilityBlueprintFactory",
        }

    asset_name, package_path = split_asset_name_and_path(asset_name, content_path)
    asset_path = "{0}/{1}".format(package_path, asset_name)
    if unreal.EditorAssetLibrary.does_asset_exist(asset_path):
        return {
            "success": False,
            "message": "Asset already exists: {0}".format(asset_path),
            "reason": "asset_already_exists",
            "asset_path": asset_path,
            "persisted": True,
        }

    factory = factory_class()
    if parent_uclass is not None:
        try:
            factory.set_editor_property("parent_class", parent_uclass)
        except Exception as exc:
            return {
                "success": False,
                "message": "Failed to assign editor utility parent class '{0}': {1}".format(
                    parent_class_name, exc
                ),
            }

    asset = create_asset_with_factory(asset_name, package_path, asset_class, factory)
    if not asset:
        return {
            "success": False,
            "message": "Failed to create editor utility asset '{0}'.".format(asset_name),
            "asset_path": asset_path,
        }

    asset_class_name = get_object_class_name(asset)
    if not isinstance(asset, asset_class):
        return {
            "success": False,
            "reason": "unexpected_asset_class",
            "message": "Factory created {0} instead of {1} for '{2}'; refusing to report success.".format(
                asset_class_name, get_object_name(asset_class), asset_path
            ),
            "asset_path": asset_path,
            "asset_class": asset_class_name,
        }

    saved = save_loaded_editor_asset(asset)
    persisted = False
    try:
        persisted = bool(unreal.EditorAssetLibrary.does_asset_exist(asset_path))
    except Exception:
        persisted = False

    if not persisted:
        return {
            "success": False,
            "reason": "asset_not_persisted",
            "message": "Editor utility asset '{0}' was created in memory but could not be saved to disk.".format(
                asset_path
            ),
            "asset_path": asset_path,
            "persisted": False,
            "saved": bool(saved),
        }

    created_parent = get_editor_property_value(asset, "parent_class")
    if required_parent_class is not None:
        if created_parent is None:
            if not asset_class_fallback:
                warnings.append(
                    "Could not read the created asset parent_class; expected {0}.".format(
                        required_parent_name
                    )
                )
        elif not class_is_child_of(created_parent, required_parent_class):
            return {
                "success": False,
                "reason": "unexpected_parent_class",
                "message": "Created asset parent class is {0}, expected a {1} subclass.".format(
                    get_object_name(created_parent), required_parent_name
                ),
                "asset_path": asset_path,
            }

    result = {
        "success": True,
        "action": action_name,
        "name": asset_name,
        "asset_path": asset_path,
        "asset_class": asset_class_name,
        "parent_class": get_object_name(created_parent) if created_parent else parent_class_name,
        "factory_class": get_object_class_name(factory),
        "persisted": True,
        "saved": bool(saved),
    }
    if required_parent_name:
        result["action_utility"] = required_parent_name
    if asset_class_fallback:
        result["editor_utility_asset"] = False
        result["fallback_asset"] = True
    else:
        result["editor_utility_asset"] = True
    if warnings:
        result["warnings"] = warnings

    return result


def create_editor_utility_blueprint(args):
    return _umg_create_editor_utility_asset(
        args,
        "create_editor_utility_blueprint",
        args.get("parent_class"),
        None,
    )


def create_actor_action_utility(args):
    return _umg_create_editor_utility_asset(
        args,
        "create_actor_action_utility",
        args.get("parent_class") or "ActorActionUtility",
        "ActorActionUtility",
    )


def create_asset_action_utility(args):
    return _umg_create_editor_utility_asset(
        args,
        "create_asset_action_utility",
        args.get("parent_class") or "AssetActionUtility",
        "AssetActionUtility",
    )


def close_editor_utility(args):
    asset_path = (
        args.get("asset_path")
        or args.get("path")
        or args.get("widget_blueprint_path")
        or args.get("widget_name")
    )
    if not asset_path:
        return {"success": False, "message": "asset_path is required."}

    pie_error = require_editor_not_in_play("close_editor_utility")
    if pie_error:
        return pie_error

    asset_editor_class = getattr(unreal, "AssetEditorSubsystem", None)
    if asset_editor_class is None:
        return {
            "success": False,
            "reason": "unsupported_capability",
            "message": "unreal.AssetEditorSubsystem is not exposed in this engine version; cannot close or verify editor tabs.",
            "unsupported_capability": "AssetEditorSubsystem",
        }

    try:
        asset = None
        try:
            asset = load_blueprint_asset(asset_path, allow_widget=True)
        except Exception:
            asset = None
        if not asset:
            asset = unreal.EditorAssetLibrary.load_asset(asset_path)
        if not asset:
            return {
                "success": False,
                "message": "Editor utility asset not found: {0}".format(asset_path),
            }

        resolved_path = get_asset_package_name(asset) or asset_path
        asset_class_name = get_object_class_name(asset)
        warnings = []

        asset_editor_subsystem = unreal.get_editor_subsystem(asset_editor_class)
        if not asset_editor_subsystem:
            return {
                "success": False,
                "reason": "unsupported_capability",
                "message": "AssetEditorSubsystem is unavailable; cannot close editor tabs.",
                "unsupported_capability": "AssetEditorSubsystem",
            }

        utility_class = getattr(unreal, "EditorUtilitySubsystem", None)
        utility_subsystem = (
            unreal.get_editor_subsystem(utility_class) if utility_class else None
        )
        tab_id = unreal.Name("{0}_ActiveTab".format(asset.get_path_name()))
        was_open = False
        if utility_subsystem is not None:
            try:
                was_open = bool(utility_subsystem.does_tab_exist(tab_id))
            except Exception as exc:
                warnings.append(
                    "Could not check the utility tab before closing: {0}".format(exc)
                )

        closed_editors = 0
        try:
            closed_editors = int(
                bool(asset_editor_subsystem.close_all_editors_for_asset(asset))
            )
        except Exception as exc:
            warnings.append("close_all_editors_for_asset failed: {0}".format(exc))

        closed_utility_tab = False
        if utility_subsystem is not None:
            try:
                if utility_subsystem.does_tab_exist(tab_id):
                    closed_utility_tab = bool(utility_subsystem.close_tab_by_id(tab_id))
                    if not closed_utility_tab:
                        warnings.append(
                            "EditorUtilitySubsystem.close_tab_by_id returned false for {0}.".format(
                                tab_id
                            )
                        )
            except Exception as exc:
                warnings.append(
                    "EditorUtilitySubsystem tab close failed: {0}".format(exc)
                )

        still_open = False
        if utility_subsystem is not None:
            try:
                still_open = bool(utility_subsystem.does_tab_exist(tab_id))
            except Exception:
                still_open = False

        if still_open:
            return {
                "success": False,
                "reason": "close_failed",
                "message": "Asset editor for '{0}' is still open after closing attempts.".format(
                    resolved_path
                ),
                "asset_path": resolved_path,
                "asset_class": asset_class_name,
                "closed_editors": closed_editors,
                "closed_utility_tab": closed_utility_tab,
                "warnings": warnings,
            }

        result = {
            "success": True,
            "action": "close_editor_utility",
            "asset_path": resolved_path,
            "asset_class": asset_class_name,
            "closed_editors": closed_editors,
            "closed_utility_tab": closed_utility_tab,
            "already_closed": not (bool(closed_editors) or closed_utility_tab or was_open),
        }
        if warnings:
            result["warnings"] = warnings
        return result
    except Exception as exc:
        return {"success": False, "message": str(exc)}


def _umg_tab_exists(utility_subsystem, object_path):
    if utility_subsystem is None:
        return None
    try:
        tab_id = unreal.Name("{0}_ActiveTab".format(object_path))
        return bool(utility_subsystem.does_tab_exist(tab_id))
    except Exception:
        return None


def _umg_registry_assets(class_name):
    try:
        registry = unreal.AssetRegistryHelpers.get_asset_registry()
        return list(registry.get_assets_by_class(class_name, True))
    except Exception:
        return None


def list_open_editor_tools(args):
    utility_class = getattr(unreal, "EditorUtilitySubsystem", None)
    utility_subsystem = (
        unreal.get_editor_subsystem(utility_class) if utility_class else None
    )
    utility_blueprint_class = getattr(unreal, "EditorUtilityBlueprint", None)
    widget_blueprint_class = getattr(unreal, "EditorUtilityWidgetBlueprint", None)
    warnings = [
        "tab_title is the asset name; UE4.27 Python does not expose asset editor tab labels."
    ]
    if utility_subsystem is None:
        warnings.append(
            "EditorUtilitySubsystem is unavailable; registered utility tab state cannot be checked."
        )
    if utility_blueprint_class is None:
        warnings.append(
            "unreal.EditorUtilityBlueprint is not exposed; editor utility blueprints that are open in an asset editor tab are only listed when the AssetEditorSubsystem exposes GetEditedAssets."
        )

    tools = []
    seen = set()
    mode = "utility_tab_scan"

    if widget_blueprint_class is not None:
        asset_datas = _umg_registry_assets("EditorUtilityWidgetBlueprint")
        if asset_datas is None:
            warnings.append(
                "AssetRegistry.get_assets_by_class is unavailable; cannot enumerate editor utility widget blueprints."
            )
            mode = "edited_assets"
        else:
            for asset_data in asset_datas:
                try:
                    object_path = str(asset_data.object_path)
                except Exception:
                    continue
                if not object_path:
                    continue
                open_state = _umg_tab_exists(utility_subsystem, object_path)
                if not open_state:
                    continue
                key = object_path.lower()
                seen.add(key)
                package_path = object_path.split(".")[0]
                tools.append(
                    {
                        "asset_path": package_path,
                        "asset_name": package_path.rsplit("/", 1)[-1],
                        "asset_class": "EditorUtilityWidgetBlueprint",
                        "kind": "editor_utility_widget",
                        "tab_title": package_path.rsplit("/", 1)[-1],
                        "tab_title_source": "asset_name",
                        "registered_utility_tab": True,
                        "open_state_source": "utility_tab",
                    }
                )

    asset_editor_class = getattr(unreal, "AssetEditorSubsystem", None)
    if asset_editor_class is not None:
        edited_assets = []
        try:
            asset_editor_subsystem = unreal.get_editor_subsystem(asset_editor_class)
            if asset_editor_subsystem:
                edited_assets = list(asset_editor_subsystem.get_all_edited_assets())
        except Exception:
            edited_assets = []
        for asset in edited_assets:
            if not asset:
                continue
            is_widget = bool(
                widget_blueprint_class and isinstance(asset, widget_blueprint_class)
            )
            is_utility_blueprint = bool(
                utility_blueprint_class and isinstance(asset, utility_blueprint_class)
            )
            if not (is_widget or is_utility_blueprint):
                continue
            package_path = get_asset_package_name(asset)
            key = str(package_path or "").lower()
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            entry = {
                "asset_path": package_path,
                "asset_name": get_object_name(asset),
                "asset_class": get_object_class_name(asset),
                "kind": "editor_utility_widget" if is_widget else "editor_utility_blueprint",
                "tab_title": get_object_name(asset),
                "tab_title_source": "asset_name",
                "open_state_source": "edited_assets",
            }
            if utility_subsystem is not None and package_path:
                entry["registered_utility_tab"] = _umg_tab_exists(
                    utility_subsystem, asset.get_path_name()
                )
            tools.append(entry)

    tools.sort(key=lambda entry: str(entry.get("asset_path") or "").lower())
    return {
        "success": True,
        "action": "list_open_editor_tools",
        "count": len(tools),
        "tools": tools,
        "mode": mode,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
# Compatibility guard for manage_widget.create_widget_blueprint.
# Design doc line 502: it must not silently create a plain WidgetBlueprint for
# an EditorUtilityWidget parent. Delegate to the verified EditorUtility factory
# path and surface a deprecation warning, or fail clearly.
# ---------------------------------------------------------------------------


def create_umg_widget_blueprint_with_editor_utility_guard(args):
    parent_class_name = args.get("parent_class")
    if not parent_class_name:
        return create_umg_widget_blueprint(args)

    parent_class = None
    try:
        parent_class = resolve_class_reference(parent_class_name, ["UMG"])
    except Exception:
        parent_class = None

    editor_utility_base = getattr(unreal, "EditorUtilityWidget", None)
    is_editor_utility = bool(
        parent_class
        and editor_utility_base
        and class_is_child_of(parent_class, editor_utility_base)
    )
    if not is_editor_utility:
        return create_umg_widget_blueprint(args)

    has_factory = bool(
        getattr(unreal, "EditorUtilityWidgetBlueprintFactory", None)
        and getattr(unreal, "EditorUtilityWidgetBlueprint", None)
    )
    if not has_factory:
        return {
            "success": False,
            "reason": "unsupported_capability",
            "message": "Creating an EditorUtilityWidget parent requires unreal.EditorUtilityWidgetBlueprintFactory, which is not exposed in this engine version. Use manage_editor_tool.create_editor_utility_widget on a supported build.",
            "unsupported_capability": "EditorUtilityWidgetBlueprintFactory",
        }

    result = create_umg_widget_blueprint(args)
    if not isinstance(result, dict) or not result.get("success"):
        return result

    asset_path = result.get("asset_path")
    expected_class = getattr(unreal, "EditorUtilityWidgetBlueprint", None)
    if asset_path and expected_class:
        asset = None
        try:
            asset = unreal.EditorAssetLibrary.load_asset(asset_path)
        except Exception:
            asset = None
        if asset is not None and not isinstance(asset, expected_class):
            return {
                "success": False,
                "reason": "unexpected_asset_class",
                "message": "Created {0} instead of EditorUtilityWidgetBlueprint for '{1}'. Use manage_editor_tool.create_editor_utility_widget.".format(
                    get_object_class_name(asset), asset_path
                ),
                "asset_path": asset_path,
                "asset_class": get_object_class_name(asset),
            }

    warnings = list(result.get("warnings") or [])
    warnings.append(
        "Deprecated: manage_widget.create_widget_blueprint with an EditorUtilityWidget parent_class. Use manage_editor_tool.create_editor_utility_widget instead."
    )
    result["warnings"] = warnings
    result["delegated_to"] = "manage_editor_tool.create_editor_utility_widget"
    return result


OPERATIONS = {
    "create_umg_widget_blueprint": create_umg_widget_blueprint_with_editor_utility_guard,
    "launch_editor_utility": launch_editor_utility,
    "ensure_canvas_root": ensure_canvas_root_for_widget,
    "inspect_widget_tree": inspect_widget_tree,
    "add_text_block_to_widget": add_text_block_to_widget,
    "add_button_to_widget": add_button_to_widget,
    "bind_widget_event": bind_widget_event,
    "add_widget_to_viewport": add_widget_to_viewport,
    "release_viewport_widgets": release_viewport_widgets,
    "set_text_block_binding": set_text_block_binding,
    "set_anchors": set_widget_anchors,
    "set_alignment": set_widget_alignment,
    "set_offsets": set_widget_offsets,
    "set_size": set_widget_size,
    "set_padding": set_widget_padding,
    "add_panel": add_panel_to_widget,
    "set_slot": set_widget_slot,
    "set_widget_property": set_widget_property_value,
    "list_events": list_widget_events,
    "create_editor_utility_blueprint": create_editor_utility_blueprint,
    "create_actor_action_utility": create_actor_action_utility,
    "create_asset_action_utility": create_asset_action_utility,
    "close_editor_utility": close_editor_utility,
    "list_open_editor_tools": list_open_editor_tools,
    # 1.7 designer lane: native tree, style and preview operations.
    "insert_widget": insert_widget_action,
    "reorder_child": reorder_child_action,
    "duplicate_widget": duplicate_widget_action,
    "rename_widget": rename_widget_action,
    "serialize_tree": serialize_tree_action,
    "validate_widget": validate_widget_action,
    "set_style": set_style_action,
    "set_brush": set_brush_action,
    "list_delegates": list_delegates_action,
    "list_bound_events": list_bound_events_action,
    "unbind_event": unbind_event_action,
    "designer_screenshot": designer_screenshot_action,
    "inspect_selection": inspect_selection_action,
    # 1.7: the legacy structural scripts now route through the native tree lane so that
    # delete purges bindings/variable nodes/animations and every structural edit batches
    # its compile. The action names and argument shapes are unchanged.
    "add_widget": add_widget_action,
    "add_child_widget": add_child_widget_action,
    "remove_widget": remove_widget_action,
    "remove_child_widget": remove_child_widget_action,
    "reparent_widget": reparent_widget_action,
}


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")

    handler = OPERATIONS.get(operation)
    if not handler:
        print(
            json.dumps(
                {
                    "success": False,
                    "message": "Unknown UMG tool operation: {0}".format(operation),
                },
                indent=2,
            )
        )
        return

    try:
        result = handler(args or {})
    except Exception as exc:
        result = {"success": False, "message": str(exc)}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
