import json


def to_jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if hasattr(value, "pitch") and hasattr(value, "yaw") and hasattr(value, "roll"):
        return {
            "pitch": to_jsonable(value.pitch),
            "yaw": to_jsonable(value.yaw),
            "roll": to_jsonable(value.roll),
        }
    if hasattr(value, "x") and hasattr(value, "y"):
        result = {"x": to_jsonable(value.x), "y": to_jsonable(value.y)}
        if hasattr(value, "z"):
            result["z"] = to_jsonable(value.z)
        return result
    return str(value)


def get_components(actor, component_class):
    try:
        return list(actor.get_components_by_class(component_class) or [])
    except Exception:
        return []


def actor_summary(actor):
    try:
        location = to_jsonable(actor.get_actor_location())
    except Exception:
        location = None
    return {
        "label": str(actor.get_actor_label() or ""),
        "name": str(actor.get_name() or ""),
        "path": str(actor.get_path_name() or ""),
        "class": str(actor.get_class().get_name() or ""),
        "location": location,
    }


def describe_brain(actor):
    brain_class = getattr(unreal, "BrainComponent", None)
    if brain_class is None:
        return None
    for component in get_components(actor, brain_class):
        behavior_tree = None
        try:
            behavior_tree = component.get_editor_property("behavior_tree")
        except Exception:
            behavior_tree = None
        return {
            "component": str(component.get_name() or ""),
            "class": str(component.get_class().get_name() or ""),
            "behavior_tree": to_jsonable(behavior_tree),
        }
    return None


def describe_perception(actor):
    perception_class = getattr(unreal, "AIPerceptionComponent", None)
    if perception_class is None:
        return []
    entries = []
    for component in get_components(actor, perception_class):
        senses = None
        try:
            senses = component.get_editor_property("senses_config")
        except Exception:
            senses = None
        known = []
        try:
            known = [
                str(actor.get_path_name() or "")
                for actor in (component.get_known_perceived_actors() or [])
            ]
        except Exception:
            known = []
        entries.append({
            "component": str(component.get_name() or ""),
            "class": str(component.get_class().get_name() or ""),
            "senses": to_jsonable(senses),
            "known_actors": known,
        })
    return entries


def get_ai_controllers():
    entries = []
    seen = set()
    for actor in get_all_level_actors():
        controller = actor if isinstance(actor, unreal.AIController) else None
        if controller is None and isinstance(actor, unreal.Pawn):
            try:
                controller = actor.get_controller()
            except Exception:
                controller = None
        if controller is None:
            continue
        controller_path = str(controller.get_path_name() or "")
        if controller_path in seen:
            continue
        seen.add(controller_path)
        pawn = None
        try:
            pawn = controller.get_pawn()
        except Exception:
            pawn = None
        entries.append({
            "controller": actor_summary(controller),
            "pawn": actor_summary(pawn) if pawn else None,
            "brain": describe_brain(controller),
            "perception": describe_perception(controller),
        })
    return entries


def get_perception_entries():
    entries = []
    for actor in get_all_level_actors():
        if not isinstance(actor, unreal.AIController) and not isinstance(actor, unreal.Pawn):
            continue
        perceptions = describe_perception(actor)
        if perceptions:
            entries.append({
                "actor": actor_summary(actor),
                "perception": perceptions,
            })
    return entries


def get_ai_assets():
    assets = []
    try:
        paths = unreal.EditorAssetLibrary.list_assets("/Game", recursive=True)
    except Exception:
        paths = []
    for asset_path in paths:
        try:
            asset = unreal.EditorAssetLibrary.load_asset(asset_path)
        except Exception:
            asset = None
        if asset is None:
            continue
        is_behavior_tree = hasattr(unreal, "BehaviorTree") and isinstance(asset, unreal.BehaviorTree)
        is_blackboard = hasattr(unreal, "BlackboardData") and isinstance(asset, unreal.BlackboardData)
        if not is_behavior_tree and not is_blackboard:
            continue
        item = {
            "path": str(asset_path),
            "name": str(asset.get_name() or ""),
            "class": str(asset.get_class().get_name() or ""),
        }
        if is_behavior_tree:
            try:
                item["blackboard"] = to_jsonable(asset.get_editor_property("blackboard_asset"))
            except Exception:
                item["blackboard"] = None
        assets.append(item)
    return assets


def get_navmesh_actors():
    entries = []
    bounds_class = getattr(unreal, "NavMeshBoundsVolume", None)
    recast_class = getattr(unreal, "RecastNavMesh", None)
    for actor in get_all_level_actors():
        is_bounds = bounds_class is not None and isinstance(actor, bounds_class)
        is_recast = recast_class is not None and isinstance(actor, recast_class)
        if not is_bounds and not is_recast:
            continue
        bounds = None
        try:
            origin, extent = actor.get_actor_bounds(False)
            bounds = {
                "origin": to_jsonable(origin),
                "extent": to_jsonable(extent),
            }
        except Exception:
            bounds = None
        entries.append({
            "actor": actor_summary(actor),
            "kind": "bounds" if is_bounds else "recast",
            "bounds": bounds,
        })
    return entries


READ_OPERATIONS = ("status", "actors", "assets", "navmesh", "perception")

NATIVE_UNAVAILABLE_MESSAGE = (
    "The native UEVGraphAI helper is not loaded. Blackboard key editing and behavior tree "
    "introspection require the UEVGraphAuthoring module from UEV 1.6.0; rebuild the "
    "native plugins, restart the editor and run this operation again."
)

BLACKBOARD_KEY_TYPES = (
    "Bool",
    "Int",
    "Float",
    "Vector",
    "Rotator",
    "Name",
    "String",
    "Object",
    "Class",
)


class NativeHelperUnavailable(RuntimeError):
    pass


def read_template_args():
    decoded = decode_template_json("""${typeof args === "undefined" ? "" : args}""")
    if isinstance(decoded, dict):
        return decoded
    return {}


def get_native_helper():
    helper_class = getattr(unreal, "UEVGraphAI", None)
    if helper_class is None:
        return None
    return helper_class


def native_call(function_name, *arguments):
    helper = get_native_helper()
    if helper is None:
        raise NativeHelperUnavailable(NATIVE_UNAVAILABLE_MESSAGE)

    function = getattr(helper, function_name, None)
    if function is None:
        raise NativeHelperUnavailable(
            "UEVGraphAI.{0} is not available in the loaded UEVGraphAuthoring module; rebuild the native plugins.".format(function_name)
        )

    raw_output = function(*arguments)
    if not isinstance(raw_output, str):
        return {
            "success": False,
            "message": "UEVGraphAI.{0} returned an unexpected {1} value.".format(
                function_name, type(raw_output).__name__
            ),
        }

    try:
        parsed = json.loads(raw_output)
    except Exception:
        return {
            "success": False,
            "message": "UEVGraphAI.{0} returned output that is not valid JSON.".format(function_name),
            "raw": raw_output[:2000],
        }

    if not isinstance(parsed, dict):
        return {
            "success": False,
            "message": "UEVGraphAI.{0} returned {1} instead of an object.".format(
                function_name, type(parsed).__name__
            ),
        }

    return parsed


def resolve_asset_path(identifier, allowed_class_names, label):
    if not identifier or not str(identifier).strip():
        raise ValueError("{0} is required".format(label))
    asset = load_asset_by_identifier(str(identifier).strip(), allowed_class_names)
    try:
        resolved = str(asset.get_path_name() or "")
    except Exception:
        resolved = ""
    if not resolved:
        raise ValueError("Could not resolve an object path for asset: {0}".format(identifier))
    return resolved


def describe_asset_identity(asset):
    try:
        return {
            "name": str(asset.get_name() or ""),
            "path": str(asset.get_path_name() or ""),
            "class": str(asset.get_class().get_name() or ""),
        }
    except Exception:
        return {}


def describe_behavior_tree_fallback(asset_path):
    identity = {"name": "", "path": asset_path, "class": "BehaviorTree"}
    try:
        asset = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception:
        asset = None
    if asset is None:
        return identity

    identity = describe_asset_identity(asset)
    blackboard_path = ""
    try:
        blackboard_asset = asset.get_editor_property("blackboard_asset")
        if blackboard_asset:
            blackboard_path = str(blackboard_asset.get_path_name() or "")
    except Exception:
        blackboard_path = ""
    identity["blackboard_path"] = blackboard_path
    return identity


def describe_assign_environment(target, pawn_name):
    controllers = []
    matched_controller = None
    target_lower = str(target or "").lower()
    for actor in get_all_level_actors():
        if not isinstance(actor, unreal.AIController):
            continue
        summary = actor_summary(actor)
        controllers.append(summary)
        if matched_controller is None and target_lower:
            if target_lower in (
                summary["name"].lower(),
                summary["label"].lower(),
                summary["path"].lower(),
            ):
                matched_controller = summary

    matched_pawn = None
    pawn_lower = str(pawn_name or "").lower()
    if pawn_lower:
        for actor in get_all_level_actors():
            if not isinstance(actor, unreal.Pawn):
                continue
            summary = actor_summary(actor)
            if pawn_lower in (
                summary["name"].lower(),
                summary["label"].lower(),
                summary["path"].lower(),
            ):
                matched_pawn = summary
                break

    return {
        "target_controller": matched_controller,
        "target_is_placed_controller": matched_controller is not None,
        "pawn": matched_pawn,
        "level_ai_controllers": controllers,
    }


def read_operation(operation):
    world = get_editor_world()
    controllers = get_ai_controllers()
    assets = get_ai_assets()
    navmesh = get_navmesh_actors()
    perception = get_perception_entries()
    warnings = []

    if not controllers:
        warnings.append("No AI controllers were found in the current level.")
    if not assets:
        warnings.append("No BehaviorTree or BlackboardData assets were found under /Game.")
    if not navmesh:
        warnings.append("No NavMeshBoundsVolume or RecastNavMesh actors were found.")

    base = {
        "success": True,
        "available": True,
        "operation": operation,
        "world": {
            "name": str(world.get_name() or "") if world else "",
            "path": str(world.get_path_name() or "") if world else "",
        },
        "counts": {
            "ai_controllers": len(controllers),
            "ai_assets": len(assets),
            "navmesh_actors": len(navmesh),
            "perception_actors": len(perception),
        },
        "warnings": warnings,
        "generatedAt": None,
    }

    if operation == "actors":
        base["ai_controllers"] = controllers
    elif operation == "assets":
        base["ai_assets"] = assets
    elif operation == "navmesh":
        base["navmesh_actors"] = navmesh
    elif operation == "perception":
        base["perception_actors"] = perception
    elif operation == "status":
        base["ai_controllers"] = controllers
        base["ai_assets"] = assets
        base["navmesh_actors"] = navmesh
        base["perception_actors"] = perception

    return base


def op_create_blackboard(args):
    requested_name = str(args.get("name") or args.get("asset_name") or "").strip()
    if not requested_name:
        raise ValueError("Provide name or asset_name.")

    content_path = str(args.get("path") or "/Game/AI").strip() or "/Game/AI"
    asset_leaf_name, package_path = split_asset_name_and_path(requested_name, content_path)
    asset_path = "{0}/{1}".format(package_path, asset_leaf_name)

    existing = None
    try:
        existing = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception:
        existing = None

    blackboard_class = getattr(unreal, "BlackboardData", None)
    if existing is not None:
        is_blackboard = blackboard_class is not None and isinstance(existing, blackboard_class)
        if not is_blackboard:
            raise ValueError(
                "An asset of class {0} already exists at {1}; choose another name or path.".format(
                    get_object_class_name(existing), asset_path
                )
            )
        result = {
            "success": True,
            "created": False,
            "existing": True,
            "asset_path": asset_path,
            "blackboard": describe_asset_identity(existing),
            "saved": False,
            "warnings": [
                "A BlackboardData asset already exists at {0}; it was left unchanged.".format(asset_path)
            ],
        }
        if get_native_helper() is not None:
            try:
                result["details"] = native_call(
                    "describe_blackboard", str(existing.get_path_name() or asset_path)
                )
            except Exception as exc:
                result["warnings"].append(str(exc))
        return result

    factory_class = getattr(unreal, "BlackboardDataFactory", None)
    if factory_class is None or blackboard_class is None:
        raise ValueError(
            "BlackboardDataFactory is not available in this editor build; cannot create a blackboard asset."
        )

    try:
        asset = create_asset_with_factory(
            asset_leaf_name, package_path, blackboard_class, factory_class()
        )
    except Exception as exc:
        raise ValueError(
            "Failed to create BlackboardData asset at {0}: {1}".format(asset_path, exc)
        )

    if not asset:
        raise ValueError("Failed to create BlackboardData asset at {0}.".format(asset_path))

    saved = False
    try:
        saved = bool(save_loaded_editor_asset(asset))
    except Exception:
        saved = False

    warnings = []
    if not saved:
        warnings.append(
            "The asset was created but the editor did not confirm that it was saved; save it manually if it is missing on disk."
        )

    return {
        "success": True,
        "created": True,
        "existing": False,
        "asset_path": asset_path,
        "blackboard": describe_asset_identity(asset),
        "saved": saved,
        "warnings": warnings,
    }


def add_parent_blackboard_warning(result, blackboard):
    parent_path = str((blackboard or {}).get("parent") or "")
    if not parent_path:
        return result
    warnings = result.get("warnings") or []
    if not isinstance(warnings, list):
        warnings = []
    warnings.append(
        "Keys inherited from parent blackboard {0} are not listed here; inspect the parent blackboard to see them.".format(parent_path)
    )
    result["warnings"] = warnings
    return result


def op_list_blackboard_keys(args):
    blackboard_path = resolve_asset_path(
        args.get("blackboard_path"), ["BlackboardData"], "blackboard_path"
    )
    result = native_call("describe_blackboard", blackboard_path)
    result.setdefault("success", True)
    result["blackboard_path"] = blackboard_path
    blackboard = result.get("blackboard") or {}
    result["blackboard"] = blackboard
    result["keys"] = blackboard.get("keys") or []
    result["key_count"] = blackboard.get("key_count")
    result["local_key_count"] = blackboard.get("local_key_count")
    return add_parent_blackboard_warning(result, blackboard)


def op_add_blackboard_key(args):
    blackboard_path = resolve_asset_path(
        args.get("blackboard_path"), ["BlackboardData"], "blackboard_path"
    )
    key_name = str(args.get("key_name") or "").strip()
    if not key_name:
        raise ValueError("key_name is required")
    key_type = str(args.get("key_type") or "").strip()
    if not key_type:
        raise ValueError("key_type is required")
    if key_type.lower() not in [item.lower() for item in BLACKBOARD_KEY_TYPES]:
        raise ValueError(
            "Unsupported key_type: {0}. Use {1}.".format(key_type, ", ".join(BLACKBOARD_KEY_TYPES))
        )

    instance_synced = bool(args.get("instance_synced", False))
    category = str(args.get("category") or "")
    base_class = str(args.get("base_class") or "")

    result = native_call(
        "add_blackboard_key",
        blackboard_path,
        key_name,
        key_type,
        instance_synced,
        category,
        base_class,
    )
    result.setdefault("success", True)
    result["blackboard_path"] = blackboard_path
    return result


def op_remove_blackboard_key(args):
    blackboard_path = resolve_asset_path(
        args.get("blackboard_path"), ["BlackboardData"], "blackboard_path"
    )
    key_name = str(args.get("key_name") or "").strip()
    if not key_name:
        raise ValueError("key_name is required")

    result = native_call("remove_blackboard_key", blackboard_path, key_name)
    result.setdefault("success", True)
    result["blackboard_path"] = blackboard_path
    return result


def op_inspect_behavior_tree(args):
    behavior_tree_path = resolve_asset_path(
        args.get("behavior_tree_path"), ["BehaviorTree"], "behavior_tree_path"
    )
    if get_native_helper() is None:
        return {
            "success": False,
            "available": True,
            "native_available": False,
            "code": "plugin.unavailable",
            "behavior_tree_path": behavior_tree_path,
            "behavior_tree": describe_behavior_tree_fallback(behavior_tree_path),
            "message": NATIVE_UNAVAILABLE_MESSAGE
            + " Only the asset identity and its blackboard reference could be reported, so the tree structure is unknown.",
        }

    result = native_call("describe_behavior_tree", behavior_tree_path)
    result.setdefault("success", True)
    result["behavior_tree_path"] = behavior_tree_path
    result["native_available"] = True
    return add_parent_blackboard_warning(result, result.get("blackboard"))


def op_assign_behavior_tree(args):
    behavior_tree_path = resolve_asset_path(
        args.get("behavior_tree_path"), ["BehaviorTree"], "behavior_tree_path"
    )
    target = str(args.get("target") or "").strip()
    if not target:
        raise ValueError("target is required")
    pawn = str(args.get("pawn") or "")
    spawn_if_missing = bool(args.get("spawn_if_missing", False))
    possess = bool(args.get("possess", False))

    if get_native_helper() is None:
        return {
            "success": False,
            "available": True,
            "native_available": False,
            "code": "plugin.unavailable",
            "behavior_tree_path": behavior_tree_path,
            "message": NATIVE_UNAVAILABLE_MESSAGE,
            "details": describe_assign_environment(target, pawn),
        }

    result = native_call(
        "assign_behavior_tree",
        behavior_tree_path,
        target,
        pawn,
        spawn_if_missing,
        possess,
    )
    result.setdefault("success", True)
    result["behavior_tree_path"] = behavior_tree_path
    result["native_available"] = True
    return result


OPERATIONS = {
    "status": lambda args: read_operation("status"),
    "actors": lambda args: read_operation("actors"),
    "assets": lambda args: read_operation("assets"),
    "navmesh": lambda args: read_operation("navmesh"),
    "perception": lambda args: read_operation("perception"),
    "create_blackboard": op_create_blackboard,
    "list_blackboard_keys": op_list_blackboard_keys,
    "add_blackboard_key": op_add_blackboard_key,
    "remove_blackboard_key": op_remove_blackboard_key,
    "inspect_behavior_tree": op_inspect_behavior_tree,
    "assign_behavior_tree": op_assign_behavior_tree,
}


def main():
    operation = str(decode_template_json("""${operation}""") or "status").strip().lower()
    args = read_template_args()

    handler = OPERATIONS.get(operation)
    if handler is None:
        base = {
            "success": False,
            "available": True,
            "message": "Unsupported AI debug operation: {0}".format(operation),
        }
    else:
        try:
            base = handler(args)
        except NativeHelperUnavailable as exc:
            base = {
                "success": False,
                "available": True,
                "code": "plugin.unavailable",
                "message": str(exc),
            }
        except Exception as exc:
            base = {
                "success": False,
                "available": True,
                "message": str(exc),
            }
        if not isinstance(base, dict):
            base = {
                "success": False,
                "available": True,
                "message": "AI operation {0} returned an unexpected result.".format(operation),
            }

    base.setdefault("operation", operation)
    base.setdefault("available", True)
    base["generatedAt"] = None
    print(json.dumps(to_jsonable(base), indent=2))


if __name__ == "__main__":
    main()
