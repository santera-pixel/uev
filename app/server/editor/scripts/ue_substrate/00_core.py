import contextlib
import json

try:
    import unreal
except Exception:  # pragma: no cover - only happens outside the editor
    unreal = None


# ---------------------------------------------------------------------------
# Result envelope
# ---------------------------------------------------------------------------

def ok(**payload):
    result = {"success": True}
    result.update(payload)
    return result


def fail(code, message, remedy=None, **payload):
    result = {"success": False, "code": code, "message": message}
    if remedy:
        result["remedy"] = remedy
    result.update(payload)
    return result


def emit(result):
    print(json.dumps(result, indent=2))


# ---------------------------------------------------------------------------
# Object handles
#
# Python objects do not survive between remote-execution calls, so a reference is
# retained natively (UEVNative) and referred to by an opaque handle.
# ---------------------------------------------------------------------------

_HANDLE_PREFIX = "obj_"
STABLE_HANDLE_PREFIX = "uev:"
_REGISTRY_GENERATION = 0


def handle_generation():
    return _REGISTRY_GENERATION


def has_native_history():
    return unreal is not None and hasattr(unreal, "UEVLibrary")


def retain_handle(obj):
    if obj is None:
        return None
    if not has_native_history():
        return None
    try:
        index = int(unreal.UEVLibrary.retain_object(obj))
    except Exception:
        return None
    if index < 0:
        return None
    return "{0}{1}".format(_HANDLE_PREFIX, index)


def _handle_kind(obj):
    if obj is None:
        return "object"
    try:
        if isinstance(obj, unreal.Actor):
            return "actor"
    except Exception:
        pass
    path = _safe(lambda: obj.get_path_name()) or ""
    if path.startswith("/") and ":" not in path:
        return "asset"
    return "object"


def stable_handle(obj):
    """Self-describing handle: uev:<kind>:<object path>.

    Unlike obj_<index> it does not depend on the native retained-object array, so
    it survives release_handles(), PIE transitions and editor restarts. The same
    object always produces the same string.
    """
    if obj is None:
        return None
    path = _safe(lambda: obj.get_path_name()) or ""
    if not path:
        return None
    return "{0}{1}:{2}".format(STABLE_HANDLE_PREFIX, _handle_kind(obj), path)


def _resolve_stable(kind, path):
    if not path:
        return None
    if kind == "asset":
        loaders = (
            lambda: unreal.load_object(None, path),
            lambda: unreal.EditorAssetLibrary.load_asset(path),
            lambda: unreal.EditorAssetLibrary.load_asset(path.split(".")[0]),
        )
        for loader in loaders:
            obj = _safe(loader)
            if obj:
                return obj
        return None
    for world in (editor_world(), pie_world()):
        for actor in all_actors(world):
            if (_safe(lambda a=actor: a.get_path_name()) or "") == path:
                return actor
    # A destroyed actor keeps its path until garbage collection, so
    # unreal.load_object() happily returns a dead one. An actor handle therefore
    # only resolves to an actor that is still in the editor or PIE world; that is
    # what makes a stale handle report handle_stale instead of describing a corpse.
    if kind == "actor":
        return None
    return _safe(lambda: unreal.load_object(None, path))


def object_from_handle(handle):
    if not handle or not isinstance(handle, str):
        return None
    if handle.startswith(STABLE_HANDLE_PREFIX):
        parts = handle.split(":", 2)
        if len(parts) != 3:
            return None
        return _resolve_stable(parts[1], parts[2])
    if not handle.startswith(_HANDLE_PREFIX):
        return None
    if not has_native_history():
        return None
    try:
        index = int(handle[len(_HANDLE_PREFIX):])
        return unreal.UEVLibrary.get_retained_object(index)
    except Exception:
        return None


def release_handles():
    global _REGISTRY_GENERATION
    _REGISTRY_GENERATION += 1
    if has_native_history():
        try:
            unreal.UEVLibrary.release_all_retained_objects()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Transactions
#
# One transaction per logical operation. Objects are modified inside it so the
# entry is not empty; the transaction never spans two remote-execution calls.
# ---------------------------------------------------------------------------

def _safe(call):
    try:
        return call()
    except Exception:
        return None


@contextlib.contextmanager
def mcp_transaction(label, objects=None):
    begun = False
    if has_native_history():
        begun = bool(_safe(lambda: unreal.UEVLibrary.begin_transaction(label)))

    objects = [obj for obj in (objects or []) if obj is not None]
    for obj in objects:
        _safe(lambda obj=obj: obj.modify())

    try:
        yield begun
    except Exception as error:
        if begun:
            _safe(lambda: unreal.UEVLibrary.cancel_transaction())
        raise
    else:
        if begun:
            _safe(lambda: unreal.UEVLibrary.end_transaction())


def mark_modified(objects):
    objects = [obj for obj in (objects or []) if obj is not None]
    if not objects:
        return False
    if hasattr(unreal, "UEVReflectLibrary") and hasattr(unreal.UEVReflectLibrary, "mark_modified"):
        return bool(_safe(lambda: unreal.UEVReflectLibrary.mark_modified(objects)))
    for obj in objects:
        _safe(lambda obj=obj: obj.modify())
    return True


# ---------------------------------------------------------------------------
# Worlds
# ---------------------------------------------------------------------------

def editor_world():
    return unreal.EditorLevelLibrary.get_editor_world()


def pie_world():
    try:
        worlds = unreal.EditorLevelLibrary.get_pie_worlds(False)
    except Exception:
        worlds = None
    if worlds:
        return worlds[0]
    return None


def world_for(name):
    return pie_world() if str(name or "").lower() == "pie" else editor_world()


def all_actors(world) -> list:
    if not world:
        return []
    editor = None
    try:
        editor = unreal.EditorLevelLibrary.get_editor_world()
    except Exception:
        editor = None
    if editor is not None and world == editor:
        try:
            return list(unreal.EditorLevelLibrary.get_all_level_actors())
        except Exception:
            return []
    try:
        return list(unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor))
    except Exception:
        try:
            return list(unreal.EditorLevelLibrary.get_all_level_actors())
        except Exception:
            return []


# ---------------------------------------------------------------------------
# Class resolution and matching
# ---------------------------------------------------------------------------

def resolve_class(name):
    if not name:
        return None
    if hasattr(unreal, "UEVReflectLibrary"):
        cls = _safe(lambda: unreal.UEVReflectLibrary.resolve_class(str(name)))
        if cls:
            return cls
    return _safe(lambda: getattr(unreal, str(name)))


def class_matches(obj, class_name):
    if not obj or not class_name:
        return True
    cls = resolve_class(class_name)
    if cls:
        try:
            return isinstance(obj, cls)
        except Exception:
            pass
    actual = _safe(lambda: obj.get_class().get_name())
    wanted = str(class_name).split(".")[-1]
    return bool(actual) and (actual == wanted or actual == wanted + "_C")


# ---------------------------------------------------------------------------
# Selectors
# ---------------------------------------------------------------------------

def selector_from(args):
    selector = args.get("selector")
    merged = dict(selector) if isinstance(selector, dict) else {}
    for key in ("class", "label", "tag", "component", "asset_ref", "path"):
        value = args.get(key)
        if value is not None and key not in merged:
            merged[key] = value
    merged.setdefault("world", args.get("world"))
    return merged


def resolve_targets(args):
    """Resolve a call target to a list of objects.

    Accepts a handle, an object path, or a selector. Returns (objects, error).
    """
    handle = args.get("handle")
    if handle:
        obj = object_from_handle(handle)
        if not obj:
            if isinstance(handle, str) and handle.startswith(STABLE_HANDLE_PREFIX):
                return [], fail(
                    "handle_stale",
                    "Handle {0} no longer resolves: the object was deleted or its path changed.".format(handle),
                    "Re-run manage_query.query to get a fresh handle. Stable handles are uev:<kind>:<object path> and do not expire.",
                )
            return [], fail(
                "not_found",
                "Handle {0} no longer resolves (retained-object registry generation {1}).".format(handle, _REGISTRY_GENERATION),
                "Legacy obj_<n> handles only stay valid until the native retained-object registry is released "
                "(manage_object.release_handles, PIE start/stop, editor restart). Re-run the query, or use the stable "
                "uev:<kind>:<path> handle that query results also return.",
            )
        return [obj], None

    target = args.get("target")
    if isinstance(target, str) and target.strip():
        obj = _safe(lambda: unreal.load_object(None, target.strip()))
        if not obj:
            return [], fail("not_found", "No object at path {0}.".format(target),
                            "Use manage_query.query to find the object path first.")
        return [obj], None

    selector = selector_from(args)
    if not any(selector.get(key) for key in ("class", "label", "tag", "component", "asset_ref", "path")):
        return [], fail("invalid_selector", "Provide a handle, target path, or at least one selector field.",
                        "Fields: class, label, tag, component, asset_ref, path.")

    return query_objects(selector, limit=None), None


def query_objects(selector, limit=None):
    world = world_for(selector.get("world"))
    candidates = all_actors(world)

    asset_ref = selector.get("asset_ref")
    if asset_ref:
        candidates = [actor for actor in candidates if _actor_matches_asset(actor, asset_ref)]

    class_name = selector.get("class")
    if class_name:
        candidates = [actor for actor in candidates if class_matches(actor, class_name)]

    label = selector.get("label")
    if label:
        candidates = [actor for actor in candidates if _actor_label(actor) == str(label)]

    tag = selector.get("tag")
    if tag:
        candidates = [actor for actor in candidates if str(tag) in _actor_tags(actor)]

    component = selector.get("component")
    if component:
        candidates = [actor for actor in candidates if _has_component(actor, component)]

    path = selector.get("path")
    if path:
        candidates = [actor for actor in candidates if str(path) in actor.get_path_name()]

    if limit is not None:
        candidates = candidates[: int(limit)]
    return candidates


def _actor_label(actor):
    return _safe(lambda: actor.get_actor_label()) or _safe(lambda: actor.get_name()) or ""


def _actor_tags(actor):
    tags = _safe(lambda: actor.tags)
    return [str(entry) for entry in tags] if tags else []


def _has_component(actor, component_name):
    try:
        for component in actor.get_components_by_class(unreal.ActorComponent):
            if component.get_class().get_name() == str(component_name):
                return True
    except Exception:
        return False
    return False


def _actor_matches_asset(actor, asset_path):
    try:
        components = actor.get_components_by_class(unreal.StaticMeshComponent)
        for component in components:
            mesh = component.get_editor_property("static_mesh")
            if mesh and asset_path in mesh.get_path_name():
                return True
    except Exception:
        return False
    return False


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------

def summarize(obj, compact=True):
    if obj is None:
        return None
    cls = _safe(lambda: obj.get_class().get_name()) or "?"
    path = _safe(lambda: obj.get_path_name()) or ""
    entry = {
        "handle": stable_handle(obj) or retain_handle(obj),
        "native_handle": retain_handle(obj),
        "name": _safe(lambda: obj.get_name()) or "",
        "class": cls,
        "path": path,
    }
    label = _safe(lambda: obj.get_actor_label())
    if label:
        entry["label"] = label
    if not compact:
        location = _safe(lambda: obj.get_actor_location())
        if location:
            entry["location"] = [location.x, location.y, location.z]
    return entry
