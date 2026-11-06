import json


PROPERTY_NAMES = [
    "probe_counts",
    "probe_max_ray_distance",
    "probe_history_weight",
    "probe_relocation",
    "probe_relocation_radius",
    "probe_relocation_distance",
    "probe_change_threshold",
    "probe_irradiance_encoding_gamma",
    "probe_distance_exponent",
    "probe_frontface_threshold",
    "light_multiplier",
    "emissive_multiplier",
    "view_bias",
    "normal_bias",
    "visualize_probes",
    "visualize_probe_radiance",
    "visualize_probe_irradiance",
    "visualize_probe_distance",
]
BOOLEAN_PROPERTIES = {
    "visualize_probes",
    "visualize_probe_radiance",
    "visualize_probe_irradiance",
    "visualize_probe_distance",
}
VECTOR_PROPERTIES = {"probe_counts"}
ALLOWED_PROPERTIES = set(PROPERTY_NAMES) - {"probe_relocation"}


def to_jsonable(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
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
    if hasattr(value, "r") and hasattr(value, "g") and hasattr(value, "b"):
        result = {
            "r": to_jsonable(value.r),
            "g": to_jsonable(value.g),
            "b": to_jsonable(value.b),
        }
        if hasattr(value, "a"):
            result["a"] = to_jsonable(value.a)
        return result
    return str(value)


def get_probe_count(properties):
    counts = properties.get("probe_counts")
    if isinstance(counts, dict):
        return int(counts.get("x", 0) or 0) * int(counts.get("y", 0) or 0) * int(counts.get("z", 0) or 0)
    return 0


def get_components(actor, component_class):
    try:
        components = actor.get_components_by_class(component_class)
        return list(components or [])
    except Exception:
        pass

    try:
        component = actor.get_component_by_class(component_class)
        return [component] if component else []
    except Exception:
        return []


def describe_component(actor, component):
    properties = {}
    for property_name in PROPERTY_NAMES:
        try:
            properties[property_name] = to_jsonable(component.get_editor_property(property_name))
        except Exception:
            continue

    try:
        location = to_jsonable(actor.get_actor_location())
    except Exception:
        location = None
    try:
        rotation = to_jsonable(actor.get_actor_rotation())
    except Exception:
        rotation = None
    try:
        scale = to_jsonable(actor.get_actor_scale3d())
    except Exception:
        scale = None

    return {
        "label": str(actor.get_actor_label() or ""),
        "actor_name": str(actor.get_name() or ""),
        "actor_path": str(actor.get_path_name() or ""),
        "actor_class": str(actor.get_class().get_name() or ""),
        "component_name": str(component.get_name() or ""),
        "location": location,
        "rotation": rotation,
        "scale": scale,
        "probe_count": get_probe_count(properties),
        "properties": properties,
    }


def find_volume(name):
    target = str(name or "").strip().lower()
    component_class = getattr(unreal, "DDGIVolumeComponent", None)
    if not target or component_class is None:
        return None, None

    for actor in get_all_level_actors():
        for component in get_components(actor, component_class):
            candidates = {
                str(actor.get_actor_label() or "").lower(),
                str(actor.get_name() or "").lower(),
                str(component.get_name() or "").lower(),
                str(actor.get_path_name() or "").lower(),
            }
            if target in candidates:
                return actor, component
    return None, None


def apply_properties(component, properties):
    before = {}
    after = {}
    for property_name, property_value in (properties or {}).items():
        if property_name not in ALLOWED_PROPERTIES:
            raise ValueError("Unsupported DDGI property: {0}".format(property_name))

        previous = component.get_editor_property(property_name)
        before[property_name] = to_jsonable(previous)

        if property_name in BOOLEAN_PROPERTIES:
            value = bool(property_value)
        elif property_name in VECTOR_PROPERTIES:
            value = previous
            if not hasattr(value, "x"):
                raise ValueError("DDGI property '{0}' is not a vector.".format(property_name))
            if "x" in property_value:
                value.x = int(property_value["x"])
            if "y" in property_value:
                value.y = int(property_value["y"])
            if "z" in property_value:
                value.z = int(property_value["z"])
        else:
            value = float(property_value)

        component.set_editor_property(property_name, value)
        after[property_name] = to_jsonable(component.get_editor_property(property_name))
    return before, after


def spawn_volume(name, location, rotation, scale, properties):
    component_class = getattr(unreal, "DDGIVolumeComponent", None)
    actor_class = getattr(unreal, "DDGIVolume", None)
    if component_class is None or actor_class is None:
        return {
            "success": False,
            "available": False,
            "message": "DDGIVolume/DDGIVolumeComponent is unavailable. Enable the RTXGI plugin.",
        }

    world = get_editor_world()
    if not world:
        return {"success": False, "message": "No editor world is loaded."}

    try:
        level = world.get_current_level()
        if level:
            level.modify()
    except Exception:
        pass

    location = location or {}
    rotation = rotation or {}
    scale = scale or {}
    spawn_location = unreal.Vector(
        x=float(location.get("x", 0.0)),
        y=float(location.get("y", 0.0)),
        z=float(location.get("z", 0.0)),
    )
    spawn_rotation = unreal.Rotator(
        pitch=float(rotation.get("pitch", 0.0)),
        yaw=float(rotation.get("yaw", 0.0)),
        roll=float(rotation.get("roll", 0.0)),
    )
    spawn_scale = unreal.Vector(
        x=float(scale.get("x", 1.0)),
        y=float(scale.get("y", 1.0)),
        z=float(scale.get("z", 1.0)),
    )

    actor = unreal.EditorLevelLibrary.spawn_actor_from_class(
        actor_class, spawn_location, spawn_rotation
    )
    if not actor:
        return {"success": False, "message": "Failed to spawn DDGIVolume."}

    actor.modify()
    label = str(name or "").strip() or "MCP_DDGI_Volume"
    actor.set_actor_label(label)
    actor.set_actor_scale3d(spawn_scale)

    components = get_components(actor, component_class)
    component = components[0] if components else None
    if not component:
        return {"success": False, "message": "Spawned DDGIVolume has no DDGIVolumeComponent."}

    component.modify()
    before, after = apply_properties(component, properties)
    return {
        "success": True,
        "available": True,
        "operation": "spawn",
        "volume": describe_component(actor, component),
        "before": before,
        "after": after,
    }


def update_volume(name, label, properties):
    actor, component = find_volume(name)
    if not actor or not component:
        return {"success": False, "message": "DDGI volume not found: {0}".format(name)}
    if not label and not properties:
        return {"success": False, "message": "Provide label or properties to update."}

    actor.modify()
    component.modify()
    if label:
        actor.set_actor_label(str(label).strip())
    before, after = apply_properties(component, properties)
    return {
        "success": True,
        "available": True,
        "operation": "update",
        "label": str(actor.get_actor_label() or ""),
        "volume": describe_component(actor, component),
        "before": before,
        "after": after,
    }


def delete_volume(name):
    actor, component = find_volume(name)
    if not actor or not component:
        return {"success": False, "message": "DDGI volume not found: {0}".format(name)}

    volume = describe_component(actor, component)
    actor.modify()
    if not destroy_actor(actor):
        return {"success": False, "message": "Failed to delete DDGI volume: {0}".format(name)}
    return {
        "success": True,
        "available": True,
        "operation": "delete",
        "deleted": volume,
    }


def main():
    operation = str(decode_template_json("""${operation}""") or "").strip().lower()
    name = str(decode_template_json("""${name}""") or "").strip()
    label = str(decode_template_json("""${label}""") or "").strip()
    location = decode_template_json("""${location}""")
    rotation = decode_template_json("""${rotation}""")
    scale = decode_template_json("""${scale}""")
    properties = decode_template_json("""${properties}""")

    if operation == "spawn":
        result = spawn_volume(name, location, rotation, scale, properties)
    elif operation == "update":
        result = update_volume(name, label, properties)
    elif operation == "delete":
        result = delete_volume(name)
    else:
        result = {"success": False, "message": "Unsupported DDGI operation: {0}".format(operation)}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
