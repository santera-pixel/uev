def spawn_actor(args):
    # Crash guard: spawning into the editor world while PIE is running leaves the
    # new actor under a PIE world that is later torn down.
    pie_refusal = crash_guard_refuse_pie("spawn actor")
    if pie_refusal:
        return pie_refusal

    actor_class_name = args.get("type")
    actor_name = args.get("name") or ""
    location = args.get("location") or [0.0, 0.0, 0.0]
    rotation = args.get("rotation") or [0.0, 0.0, 0.0]

    actor_class = resolve_actor_class(
        actor_class_name,
        {
            "StaticMeshActor": unreal.StaticMeshActor,
            "SkeletalMeshActor": unreal.SkeletalMeshActor,
            "DirectionalLight": unreal.DirectionalLight,
            "PointLight": unreal.PointLight,
            "SpotLight": unreal.SpotLight,
            "CameraActor": unreal.CameraActor,
            "PlayerStart": unreal.PlayerStart,
            "Character": unreal.Character,
            "Pawn": unreal.Pawn,
            "DDGIVolume": getattr(unreal, "DDGIVolume", None),
        },
    )
    if not actor_class and actor_class_name == "MCPLiveCodingTestActor":
        try:
            actor_class = unreal.load_class(None, "/Script/ViteMCPTest.MCPLiveCodingTestActor")
        except Exception:
            actor_class = None

    if not actor_class:
        return {
            "success": False,
            "message": "Could not find actor class: {0}".format(actor_class_name),
        }

    try:
        world = unreal.EditorLevelLibrary.get_editor_world()
        level = world.get_current_level() if world else None
        if level:
            level.modify()
    except Exception:
        pass

    actor = unreal.EditorLevelLibrary.spawn_actor_from_class(
        actor_class,
        _vector_from_list(location),
        _rotator_from_list(rotation),
    )
    if not actor:
        return {"success": False, "message": "Failed to spawn actor"}

    actor.modify()
    if actor_name:
        actor.set_actor_label(actor_name)

    return {"success": True, "actor": get_actor_summary(actor)}


def spawn_blueprint_actor(args):
    # Crash guard: same editor-world/PIE teardown hazard as spawn_actor.
    pie_refusal = crash_guard_refuse_pie("spawn blueprint actor")
    if pie_refusal:
        return pie_refusal

    blueprint_name = args.get("blueprint_name")
    actor_name = args.get("name") or ""
    location = args.get("location") or [0.0, 0.0, 0.0]
    rotation = args.get("rotation") or [0.0, 0.0, 0.0]
    scale = args.get("scale")
    properties = args.get("properties") or {}

    try:
        blueprint = load_blueprint_asset(blueprint_name)
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    blueprint_path = get_asset_package_name(blueprint)

    # Spawn through the Blueprint ASSET, never the generated class.
    # EditorLevelLibrary.spawn_actor_from_class() passes a UClass into the
    # level editor's placement path; for classes that are not directly
    # placeable (for example an AIController-derived Blueprint) UE4.27 then
    # selects UActorFactoryBlueprint and CastChecked<UBlueprint> asserts,
    # which hard-crashes the editor. spawn_actor_from_object() passes the
    # UBlueprint asset so the normal placeable/not-placeable guard runs and
    # a failure returns None instead of terminating the process.
    try:
        actor = unreal.EditorLevelLibrary.spawn_actor_from_object(
            blueprint,
            _vector_from_list(location),
            _rotator_from_list(rotation),
        )
    except Exception as exc:
        return {
            "success": False,
            "message": "Failed to place blueprint {0}: {1}".format(blueprint_name, exc),
        }

    if not actor:
        return {
            "success": False,
            "message": (
                "Blueprint {0} could not be placed. Its generated class is probably "
                "not placeable (Controller, GameMode, abstract, or no actor factory). "
                "Use a placeable Actor-derived Blueprint."
            ).format(blueprint_name),
        }

    if actor_name:
        actor.set_actor_label(actor_name)

    if scale is not None:
        actor.set_actor_scale3d(_vector_from_list(scale, [1.0, 1.0, 1.0]))

    for property_name, property_value in properties.items():
        apply_actor_property(actor, property_name, property_value)

    return {
        "success": True,
        "blueprint": blueprint_path,
        "actor": get_actor_summary(actor),
    }
