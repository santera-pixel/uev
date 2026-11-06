import json


def _safe_path(obj):
    try:
        return str(obj.get_path_name())
    except Exception:
        return ""


def _safe_name(obj):
    try:
        return str(obj.get_name())
    except Exception:
        return ""


def _json_arg(args, key, default=None):
    value = args.get(key)
    return default if value is None else value


def _vector(values, fallback=(0.0, 0.0, 0.0)):
    if isinstance(values, dict):
        return unreal.Vector(float(values.get("x", 0.0)), float(values.get("y", 0.0)), float(values.get("z", 0.0)))
    if not values or len(values) < 3:
        values = fallback
    return unreal.Vector(float(values[0]), float(values[1]), float(values[2]))


def _rotator(values, fallback=(0.0, 0.0, 0.0)):
    if isinstance(values, dict):
        return unreal.Rotator(float(values.get("pitch", 0.0)), float(values.get("yaw", 0.0)), float(values.get("roll", 0.0)))
    if not values or len(values) < 3:
        values = fallback
    return unreal.Rotator(float(values[0]), float(values[1]), float(values[2]))


def _apply_properties(obj, properties):
    if not isinstance(properties, dict):
        return []
    errors = []
    for path, value in properties.items():
        text = value if isinstance(value, str) else json.dumps(value) if isinstance(value, (dict, list)) else str(value)
        error = unreal.UEVReflectLibrary.set_property(obj, str(path), text)
        if error:
            errors.append({"path": path, "error": error})
    return errors


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------

def op_query(args):
    selector = selector_from(args)
    limit = int(args.get("limit", 50))
    offset = int(args.get("offset", 0))
    compact = bool(args.get("compact", True))

    found = query_objects(selector, limit=None)
    found.sort(key=lambda obj: (_safe_path(obj), _safe_name(obj)))
    total = len(found)
    page = found[offset: offset + limit]
    return ok(
        total=total,
        offset=offset,
        limit=limit,
        count=len(page),
        objects=[summarize(obj, compact) for obj in page],
    )


def op_describe(args):
    include_functions = bool(args.get("functions", False))
    class_name = args.get("class")

    if class_name:
        cls = resolve_class(class_name)
        if not cls:
            return fail("not_found", "Class {0} could not be resolved.".format(class_name),
                        "Use a full path such as /Script/Engine.PointLight.")
        return ok(schema=json.loads(unreal.UEVReflectLibrary.describe_class(cls, include_functions)))

    targets, error = resolve_targets(args)
    if error:
        return error

    obj = targets[0]
    schema = json.loads(unreal.UEVReflectLibrary.describe_object(obj, bool(args.get("values", False))))
    if include_functions:
        schema["class_schema"] = json.loads(
            unreal.UEVReflectLibrary.describe_class(obj.get_class(), True)
        )
    schema["handle"] = stable_handle(obj) or retain_handle(obj)
    schema["native_handle"] = retain_handle(obj)
    return ok(object=schema)


def op_get(args):
    targets, error = resolve_targets(args)
    if error:
        return error

    path = args.get("path")
    if not path:
        return fail("invalid_params", "path is required.")

    result = json.loads(unreal.UEVReflectLibrary.get_property(targets[0], str(path)))
    if not result.get("success"):
        return result
    result["handle"] = stable_handle(targets[0]) or retain_handle(targets[0])
    result["native_handle"] = retain_handle(targets[0])
    return result


def op_set(args):
    targets, error = resolve_targets(args)
    if error:
        return error

    obj = targets[0]
    path = args.get("path")
    if not path:
        return fail("invalid_params", "path is required.")

    value = args.get("value")
    text = value if isinstance(value, str) else json.dumps(value) if isinstance(value, (dict, list)) else str(value)

    before = json.loads(unreal.UEVReflectLibrary.get_property(obj, str(path)))
    if not before.get("success"):
        return before

    if bool(args.get("dry_run", False)):
        return ok(dry_run=True, target=summarize(obj), path=path, before=before.get("value"), after=text)

    with mcp_transaction("MCP set {0}".format(path), [obj]):
        failure = unreal.UEVReflectLibrary.set_property(obj, str(path), text)

    if failure:
        code = "type_mismatch"
        if failure.startswith("read_only"):
            code = "read_only"
        elif failure.startswith("invalid_path"):
            code = "invalid_path"
        return fail(code, failure)

    after = json.loads(unreal.UEVReflectLibrary.get_property(obj, str(path)))
    return ok(target=summarize(obj), path=path, before=before.get("value"), after=after.get("value"))


def op_call(args):
    targets, error = resolve_targets(args)
    if error:
        return error

    function_name = args.get("function")
    if not function_name:
        return fail("invalid_params", "function is required.")

    call_args = args.get("args") or []
    if not isinstance(call_args, list):
        return fail("invalid_params", "args must be an array of editor text values.")

    obj = targets[0]
    with mcp_transaction("MCP call {0}".format(function_name), [obj]):
        result = json.loads(
            unreal.UEVReflectLibrary.call_function(obj, str(function_name), [str(entry) for entry in call_args])
        )

    if result.get("success"):
        result["target"] = summarize(obj)
    return result


def _pie_worlds():
    worlds = []
    getter = getattr(unreal.EditorLevelLibrary, "get_game_world", None)
    if callable(getter):
        try:
            world = getter()
            if world:
                worlds.append(world)
        except Exception:
            pass
    getter = getattr(unreal.EditorLevelLibrary, "get_pie_worlds", None)
    if callable(getter):
        try:
            for world in list(getter()):
                if world and world not in worlds:
                    worlds.append(world)
        except Exception:
            pass
    return worlds


def _pie_actors():
    actors = []
    for world in _pie_worlds():
        try:
            for actor in list(unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor)):
                if actor not in actors:
                    actors.append(actor)
        except Exception:
            continue
    return actors


def _find_by_label(label):
    for actor in all_actors(world_for(None)):
        if _actor_label(actor) == str(label):
            return actor
    return None


def op_spawn(args, ensure_only=False):
    class_name = args.get("class")
    label = args.get("label") or args.get("name")

    if ensure_only and label:
        existing = _find_by_label(label)
        if existing:
            errors = []
            if args.get("properties"):
                with mcp_transaction("MCP ensure {0}".format(label), [existing]):
                    errors = _apply_properties(existing, args.get("properties"))
            return ok(created=False, target=summarize(existing), property_errors=errors)

    cls = resolve_class(class_name)
    if not cls:
        return fail("not_found", "Class {0} could not be resolved.".format(class_name),
                    "Pass a class path such as /Script/Engine.PointLight, or a Blueprint generated class path.")

    world = world_for(args.get("world"))
    if not world:
        return fail("not_found", "No world is available.")

    location = _vector(args.get("location"))

    if str(args.get("world") or "").lower() == "pie":
        if not hasattr(unreal, "UEVGraphLibrary"):
            return fail(
                "unsupported_capability",
                "PIE spawning needs the UEVGraphAuthoring plugin, which is not loaded.",
            )
        spawned = json.loads(
            str(
                unreal.UEVGraphLibrary.execute_graph_operation(
                    "gameplay.spawn_pie_actor",
                    json.dumps(
                        {
                            "class_path": cls.get_path_name(),
                            "location": [location.x, location.y, location.z],
                            "label": str(label or ""),
                        }
                    ),
                )
            )
        )
        if not spawned.get("success"):
            return fail(
                "spawn_failed",
                spawned.get("message") or "The native PIE spawn failed.",
            )
        actor = None
        wanted = str(spawned.get("actor_label") or spawned.get("actor_name") or label or "")
        for candidate in _pie_actors():
            names = [
                _safe_name(candidate),
                _safe(lambda: candidate.get_actor_label()) or "",
            ]
            if wanted and wanted in names:
                actor = candidate
                break
        if actor is None:
            return fail(
                "spawn_failed",
                "The actor was spawned but could not be located in the PIE world.",
            )
        if args.get("scale"):
            _safe(lambda: actor.set_actor_scale3d(_vector(args.get("scale"), (1.0, 1.0, 1.0))))
        errors = _apply_properties(actor, args.get("properties"))
        return ok(
            created=True,
            target=summarize(actor),
            spawn_method="native_spawn_pie_actor",
            property_errors=errors,
        )
    rotation = _rotator(args.get("rotation"))

    with mcp_transaction("MCP spawn {0}".format(class_name), [world]):
        actor = unreal.EditorLevelLibrary.spawn_actor_from_class(cls, location, rotation)
        if not actor:
            return fail("spawn_failed", "The editor refused to spawn {0}.".format(class_name))
        mark_modified([actor])
        if label:
            _safe(lambda: actor.set_actor_label(str(label)))
        if args.get("scale"):
            _safe(lambda: actor.set_actor_scale3d(_vector(args.get("scale"), (1.0, 1.0, 1.0))))
        if args.get("folder"):
            _safe(lambda: actor.set_folder_path(str(args.get("folder"))))
        errors = _apply_properties(actor, args.get("properties"))

    return ok(created=True, target=summarize(actor), property_errors=errors)


def op_destroy(args):
    targets, error = resolve_targets(args)
    if error:
        return error

    world = world_for(args.get("world"))
    removed = []
    with mcp_transaction("MCP destroy", list(targets) + [world]):
        for obj in targets:
            summary = summarize(obj)
            destroyed = _safe(lambda obj=obj: unreal.EditorLevelLibrary.destroy_actor(obj))
            if destroyed is None:
                destroyed = _safe(lambda obj=obj: obj.destroy_actor())
            removed.append({"target": summary, "destroyed": bool(destroyed)})

    return ok(removed=removed)


def op_duplicate(args):
    targets, error = resolve_targets(args)
    if error:
        return error

    source = targets[0]
    count = int(args.get("count", 1))
    offset = args.get("offset") or [0.0, 0.0, 200.0]
    world = world_for(args.get("world"))

    base_location = _safe(lambda: source.get_actor_location()) or unreal.Vector(0, 0, 0)
    created = []
    with mcp_transaction("MCP duplicate", [world]):
        for index in range(count):
            delta = _vector([offset[0] * (index + 1), offset[1] * (index + 1), offset[2] * (index + 1)])
            location = unreal.Vector(base_location.x + delta.x, base_location.y + delta.y, base_location.z + delta.z)
            clone = unreal.EditorLevelLibrary.spawn_actor_from_class(source.get_class(), location, source.get_actor_rotation())
            if clone:
                mark_modified([clone])
                created.append(summarize(clone))

    return ok(created=created)


def op_release(args):
    release_handles()
    return ok(released=True, generation=handle_generation(), stable_handle_prefix=STABLE_HANDLE_PREFIX)


def op_mark_modified(args):
    targets, error = resolve_targets(args)
    if error:
        return error
    return ok(marked=mark_modified(targets))


# ---------------------------------------------------------------------------
# Batch
# ---------------------------------------------------------------------------

def op_batch(args):
    operations = args.get("operations") or []
    if not isinstance(operations, list) or not operations:
        return fail("invalid_params", "operations must be a non-empty array of {action, params} entries.")

    dry_run = bool(args.get("dry_run", False))
    if dry_run:
        return ok(dry_run=True, planned=[entry.get("action") for entry in operations])

    results = []
    with mcp_transaction(str(args.get("label") or "MCP batch"), [world_for(args.get("world"))]):
        for entry in operations:
            action = entry.get("action")
            params = entry.get("params") or {}
            handler = OPERATIONS.get(str(action))
            if not handler:
                results.append(fail("not_found", "Unknown batch action {0}.".format(action)))
                continue
            try:
                results.append(handler(params))
            except Exception as error:
                results.append(fail("batch_failed", "{0}: {1}".format(action, error)))
                break

    failed = [entry for entry in results if not entry.get("success", False)]
    return ok(
        count=len(results),
        failed=len(failed),
        results=results,
        transaction=bool(has_native_history()),
    )


OPERATIONS = {
    "query": op_query,
    "describe": op_describe,
    "get": op_get,
    "set": op_set,
    "call": op_call,
    "spawn": op_spawn,
    "spawn_or_get": lambda args: op_spawn(args, ensure_only=True),
    "ensure": lambda args: op_spawn(args, ensure_only=True),
    "destroy": op_destroy,
    "duplicate": op_duplicate,
    "mark_modified": op_mark_modified,
    "release_handles": op_release,
    "batch": op_batch,
}


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""") or {}

    handler = OPERATIONS.get(str(operation))
    if not handler:
        emit(fail("not_found", "Unknown substrate operation {0}.".format(operation),
                  "Supported: " + ", ".join(sorted(OPERATIONS.keys()))))
        return

    try:
        emit(handler(args))
    except Exception as error:
        emit(fail("internal_error", str(error)))


if __name__ == "__main__":
    main()
