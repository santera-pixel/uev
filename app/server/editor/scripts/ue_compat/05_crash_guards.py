# UEV crash guards: the single editor-side home for checks that stop a tool call
# before it can take the editor down. Guard ids match server/crash-guards.ts.
#
# Every helper returns a ready-to-print refusal dict (success False plus an
# error dict and guard metadata) so handlers can `return` it unchanged, or None
# when the operation is safe to continue.

UNSAFE_OPERATIONS_ENV = "UEV_ALLOW_UNSAFE_OPERATIONS"


def crash_guard_unsafe_allowed():
    """True when the caller explicitly accepted unsafe operations via env."""
    try:
        value = os.environ.get(UNSAFE_OPERATIONS_ENV, "")
    except Exception:
        value = ""
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _crash_guard_game_world():
    getter = getattr(unreal.EditorLevelLibrary, "get_game_world", None)
    if not callable(getter):
        return None
    try:
        return getter()
    except Exception:
        return None


def _crash_guard_pie_worlds():
    getter = getattr(unreal.EditorLevelLibrary, "get_pie_worlds", None)
    if not callable(getter):
        return []
    try:
        return list(getter(False))
    except TypeError:
        try:
            return list(getter())
        except Exception:
            return []
    except Exception:
        return []


def _crash_guard_asset_registry_loading():
    helpers = getattr(unreal, "AssetRegistryHelpers", None)
    if helpers is None:
        return False
    try:
        registry = helpers.get_asset_registry()
    except Exception:
        return False
    checker = getattr(registry, "is_loading_assets", None)
    if not callable(checker):
        return False
    try:
        return bool(checker())
    except Exception:
        return False


def crash_guard_editor_state():
    """Cheap editor-state probe shared by the guards (no asset loading)."""
    game_world = _crash_guard_game_world()
    pie_worlds = _crash_guard_pie_worlds()
    return {
        "is_pie_running": bool(game_world or pie_worlds),
        "pie_world_count": len(pie_worlds),
        "game_world": game_world.get_name() if game_world else None,
        "asset_registry_loading": _crash_guard_asset_registry_loading(),
    }


def crash_guard_refusal(guard_id, title, message, hint, **details):
    """Structured refusal in the shape every UEV tool already reports errors in."""
    payload = {
        "success": False,
        "message": message,
        "error": {
            "code": "unsafe_operation_refused",
            "guard": guard_id,
            "message": message,
            "hint": hint,
        },
        "guard": {
            "id": guard_id,
            "title": title,
            "behaviour": "refuse",
        },
    }
    payload.update(details)
    return payload


PIE_HINT = (
    "Stop Play In Editor first (manage_pie.stop_pie), then retry. Set "
    "UEV_ALLOW_UNSAFE_OPERATIONS=1 only for a deliberate, backed-up operation."
)


def crash_guard_refuse_pie(operation, guard_id="pie-editor-mutation"):
    """Refuse an editor-world mutation while Play In Editor is running."""
    if crash_guard_unsafe_allowed():
        return None
    state = crash_guard_editor_state()
    if not state["is_pie_running"]:
        return None
    return crash_guard_refusal(
        guard_id,
        "Refuse editor-world mutations while Play In Editor is running",
        "Refusing to {0}: Play In Editor is running ({1} PIE world(s)).".format(
            operation, state["pie_world_count"]
        ),
        PIE_HINT,
        operation=operation,
        editor_state=state,
    )


def crash_guard_refuse_asset_registry_busy(operation):
    """Refuse asset mutations while the Asset Registry is still scanning."""
    if crash_guard_unsafe_allowed():
        return None
    if not _crash_guard_asset_registry_loading():
        return None
    return crash_guard_refusal(
        "asset-registry-busy",
        "Wait for the Asset Registry scan before mutating assets",
        "Refusing to {0}: the Asset Registry is still scanning.".format(operation),
        "Wait for the scan to finish (a few seconds after editor start) and retry.",
        operation=operation,
    )
