"""Native UMG style operations (1.7 designer lane).

set_style / set_brush read-modify-write the existing SlateBrush / FButtonStyle /
FSlateFontInfo structs through reflected editor property handles on the native side, so
engine default brush references and untouched fields survive the edit (assigning a whole
FButtonStyle would overwrite the normal/hovered/pressed brushes with defaults).
"""

_STYLE_FIELD_ALIASES = {
    'family': 'family_asset',
    'font_object': 'family_asset',
    'tint': 'tint_color',
    'texture': 'texture_path',
}


def _normalize_style_spec(spec):
    """Accept flat or nested spellings without inventing keys the native lane ignores."""
    if not isinstance(spec, dict):
        return {}
    normalized = {}
    for key, value in spec.items():
        # 'font' is both the legacy flat font-asset alias and the nested font section;
        # only a scalar font value means "font family asset".
        if key == 'font' and not isinstance(value, dict):
            target = 'family_asset'
        else:
            target = _STYLE_FIELD_ALIASES.get(key, key)
        if target in normalized and normalized[target] not in (None, ''):
            continue
        normalized[target] = value
    return normalized


def _style_payload(args):
    payload = dict(args or {})
    nested = payload.get('style')
    if isinstance(nested, dict):
        payload['style'] = _normalize_style_spec(nested)
        return payload
    flat_style = {}
    for key in ('font', 'brush', 'states', 'color', 'color_and_opacity',
                'foreground_color', 'text_color'):
        if isinstance(payload.get(key), dict):
            flat_style[key] = payload[key]
    for key in ('font_size', 'font_family', 'font_asset', 'typeface'):
        if key in payload:
            flat_style[key] = payload[key]
    if flat_style:
        payload['style'] = _normalize_style_spec(flat_style)
    return payload


def set_style_action(args):
    return uev_widget_operation('set_style', _style_payload(args))


def set_brush_action(args):
    payload = dict(args or {})
    brush = payload.get('brush')
    if isinstance(brush, dict):
        payload['brush'] = _normalize_style_spec(brush)
    return uev_widget_operation('set_brush', payload)
