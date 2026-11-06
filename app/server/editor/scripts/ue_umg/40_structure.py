"""Native UMG structure operations (1.7 designer lane).

These handlers forward to the UEV native widget lane
(unreal.UEVGraphLibrary.execute_graph_operation('widget.<op>', args_json)) because the
UE4.27 panel/widget-tree mutators (UPanelWidget::InsertChildAt, ShiftChild) are
WITH_EDITOR-only C++ and therefore unreachable from Python. The native lane performs the
transaction, the preview invalidation, the binding/animation/variable purge and a single
compile per request.

Every handler returns the native payload unchanged so callers see the uniform contract:
{success, operation, asset_path, widget{name,id,class,parent,index,slot_class}, warnings[],
 saved, preview_invalidated}.
"""

import json

import unreal

_UEV_ASSET_ARG_KEYS = (
    'asset_path',
    'widget_blueprint_path',
    'widget_blueprint',
    'widget_blueprint_asset',
    'blueprint_path',
)
_UEV_WIDGET_ARG_KEYS = (
    'widget',
    'widget_name',
    'target_widget_name',
    'widget_member_name',
    'widget_component_name',
    'child_widget_name',
)
_UEV_PARENT_ARG_KEYS = (
    'parent',
    'parent_widget',
    'parent_widget_name',
    'parent_name',
    'container_widget_name',
)


def _uev_first_value(payload, keys):
    for key in keys:
        if key in payload and payload[key] not in (None, ''):
            return payload[key]
    return None


def _uev_native_available():
    return hasattr(unreal, 'UEVGraphLibrary') and hasattr(
        unreal.UEVGraphLibrary, 'execute_graph_operation'
    )


def uev_widget_operation(operation, args, asset_keys=_UEV_ASSET_ARG_KEYS,
                         widget_keys=_UEV_WIDGET_ARG_KEYS, parent_keys=_UEV_PARENT_ARG_KEYS):
    """Call the native widget lane and return the decoded payload."""
    payload = dict(args or {})
    if not _uev_native_available():
        return {
            'success': False,
            'operation': operation,
            'message': (
                'The UEV native plugin is not loaded in this editor, so widget operation '
                "'%s' cannot run. Load the UEVNative plugin and retry." % operation
            ),
            'unsupported_capability': 'native_widget_lane',
        }
    asset = _uev_first_value(payload, asset_keys)
    if asset is not None:
        payload['asset_path'] = asset
    widget = _uev_first_value(payload, widget_keys)
    if widget is not None:
        payload['widget'] = widget
    parent = _uev_first_value(payload, parent_keys)
    if parent is not None:
        payload['parent'] = parent
    try:
        raw = unreal.UEVGraphLibrary.execute_graph_operation(
            'widget.%s' % operation, json.dumps(payload)
        )
    except Exception as exc:  # pragma: no cover - editor-side failure
        return {
            'success': False,
            'operation': operation,
            'message': 'Native widget operation %s failed: %s' % (operation, exc),
        }
    try:
        result = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return {
            'success': False,
            'operation': operation,
            'message': 'Native widget operation %s returned malformed JSON.' % operation,
            'raw': raw,
        }
    if not isinstance(result, dict):
        return {
            'success': False,
            'operation': operation,
            'message': 'Native widget operation %s returned an unexpected payload.' % operation,
        }
    result.setdefault('operation', operation)
    return result


def _apply_creation_extras(args, result, widget_name):
    """Apply the legacy text/font/colour conveniences after a native insert."""
    if not isinstance(result, dict) or not result.get('success'):
        return result
    extras = {}
    for key in ('text', 'font_size', 'color', 'background_color'):
        if args.get(key) not in (None, ''):
            extras[key] = args[key]
    if not extras:
        return result
    try:
        widget_blueprint, _ = _load_widget_blueprint(
            _uev_first_value(args, _UEV_ASSET_ARG_KEYS)
        )
        widget_tree = get_widget_tree(widget_blueprint)
        widget = find_widget_in_tree(widget_tree, widget_name)
        if widget is None:
            result.setdefault('warnings', []).append(
                'Widget %s was created but its text/font/colour extras could not be applied.' % widget_name
            )
            return result
        if extras.get('text') is not None:
            set_widget_text(widget, str(extras['text']))
        if extras.get('font_size') is not None:
            set_widget_font_size(widget, float(extras['font_size']))
        if extras.get('color') is not None:
            _try_set_widget_color(widget, extras['color'])
        if extras.get('background_color') is not None:
            _try_set_widget_background_color(widget, extras['background_color'])
        result['saved'] = bool(save_widget_blueprint(widget_blueprint))
        result['creation_extras'] = sorted(extras.keys())
    except Exception as exc:  # pragma: no cover - editor-side convenience only
        result.setdefault('warnings', []).append(
            'Widget %s was created but its extras failed: %s' % (widget_name, exc)
        )
    return result


def insert_widget_action(args):
    result = uev_widget_operation('insert_child', args)
    return _apply_creation_extras(args, result, _uev_first_value(args, _UEV_WIDGET_ARG_KEYS))


def add_widget_action(args):
    """Legacy manage_widget.add_widget, now backed by the native insert lane."""
    result = uev_widget_operation('insert_child', args)
    return _apply_creation_extras(args, result, _uev_first_value(args, _UEV_WIDGET_ARG_KEYS))


def add_child_widget_action(args):
    """Legacy manage_widget.add_child_widget, now backed by the native insert lane."""
    payload = dict(args or {})
    if 'parent' not in payload and 'parent_widget' not in payload:
        parent = _uev_first_value(payload, _UEV_WIDGET_ARG_KEYS)
        if parent is not None:
            payload['parent'] = parent
    child = _uev_first_value(payload, ('child_widget_name', 'child_name', 'new_widget_name'))
    if child is not None:
        payload['widget'] = child
    if 'class' not in payload and 'widget_class' not in payload:
        payload['class'] = 'TextBlock'
    result = uev_widget_operation('insert_child', payload, widget_keys=())
    return _apply_creation_extras(payload, result, child)


def reorder_child_action(args):
    return uev_widget_operation('reorder_child', args)


def duplicate_widget_action(args):
    return uev_widget_operation('duplicate', args)


def rename_widget_action(args):
    return uev_widget_operation('rename', args)


def remove_widget_action(args):
    """Legacy manage_widget.remove_widget, now the safe (purging) native delete."""
    return uev_widget_operation('remove_safe', args)


def remove_child_widget_action(args):
    payload = dict(args or {})
    child = _uev_first_value(payload, ('child_widget_name', 'child_name'))
    if child is not None:
        payload['widget'] = child
    return uev_widget_operation('remove_safe', payload)


def reparent_widget_action(args):
    payload = dict(args or {})
    parent = _uev_first_value(payload, ('new_parent', 'new_parent_name', 'parent_widget_name', 'parent'))
    if parent is not None:
        payload['parent'] = parent
    return uev_widget_operation('reparent', payload)


def serialize_tree_action(args):
    return uev_widget_operation('serialize_tree', args)


def validate_widget_action(args):
    return uev_widget_operation('validate', args)
