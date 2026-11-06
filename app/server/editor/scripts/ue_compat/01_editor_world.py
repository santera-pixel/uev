def get_editor_world():
    try:
        if _has_unreal_class("UnrealEditorSubsystem"):
            subsystem = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)
            if subsystem:
                world = subsystem.get_editor_world()
                if world:
                    return world
    except Exception:
        pass

    try:
        if hasattr(unreal, "EditorLevelLibrary") and hasattr(
            unreal.EditorLevelLibrary, "get_editor_world"
        ):
            return unreal.EditorLevelLibrary.get_editor_world()
    except Exception:
        pass

    return None


def get_all_level_actors():
    try:
        if _has_unreal_class("EditorActorSubsystem"):
            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            if subsystem:
                actors = subsystem.get_all_level_actors()
                if actors is not None:
                    return list(actors)
    except Exception:
        pass

    try:
        return list(unreal.EditorLevelLibrary.get_all_level_actors())
    except Exception:
        return []


def find_actor_by_name(actor_name):
    for actor in get_all_level_actors():
        try:
            if actor.get_name() == actor_name or actor.get_actor_label() == actor_name:
                return actor
        except Exception:
            continue
    return None


def destroy_actor(actor):
    try:
        if _has_unreal_class("EditorActorSubsystem"):
            subsystem = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
            if subsystem:
                return subsystem.destroy_actor(actor)
    except Exception:
        pass

    try:
        return unreal.EditorLevelLibrary.destroy_actor(actor)
    except Exception:
        return False


def get_streaming_level_names(world):
    streaming_levels = []

    try:
        streaming_levels = list(world.get_editor_property("streaming_levels"))
    except Exception:
        try:
            streaming_levels = list(world.streaming_levels)
        except Exception:
            streaming_levels = []

    names = []
    for streaming_level in streaming_levels:
        try:
            if hasattr(streaming_level, "get_world_asset_package_name"):
                name = str(streaming_level.get_world_asset_package_name())
                if name:
                    names.append(name)
                    continue
        except Exception:
            pass

        try:
            name = str(streaming_level.get_editor_property("package_name_to_load"))
            if name:
                names.append(name)
                continue
        except Exception:
            pass

        try:
            names.append(streaming_level.get_name())
        except Exception:
            continue

    return names


def is_editor_in_play():
    try:
        if hasattr(unreal.EditorLevelLibrary, "get_game_world"):
            if unreal.EditorLevelLibrary.get_game_world():
                return True
    except Exception:
        pass

    try:
        if hasattr(unreal.EditorLevelLibrary, "get_pie_worlds"):
            try:
                pie_worlds = list(unreal.EditorLevelLibrary.get_pie_worlds(False))
            except TypeError:
                pie_worlds = list(unreal.EditorLevelLibrary.get_pie_worlds())
            if pie_worlds:
                return True
    except Exception:
        pass

    return False


def require_editor_not_in_play(action_name):
    if not is_editor_in_play():
        return None

    return {
        "success": False,
        "reason": "pie_active",
        "message": "{0} requires the editor to be out of Play-In-Editor mode. Stop PIE and retry.".format(
            action_name
        ),
        "retry_action": "stop_pie",
    }
