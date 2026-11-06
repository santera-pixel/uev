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


def main():
    operation = str(decode_template_json("""${operation}""") or "list").strip().lower()
    requested_name = str(decode_template_json("""${name}""") or "").strip().lower()

    component_class = getattr(unreal, "DDGIVolumeComponent", None)
    if component_class is None:
        print(json.dumps({
            "success": False,
            "available": False,
            "message": "DDGIVolumeComponent is unavailable. Enable the RTXGI plugin.",
            "count": 0,
            "volumes": [],
            "selected": None,
        }, indent=2))
        return

    volumes = []
    for actor in unreal.EditorLevelLibrary.get_all_level_actors():
        for component in get_components(actor, component_class):
            volumes.append(describe_component(actor, component))

    selected = None
    if requested_name:
        for volume in volumes:
            candidates = {
                str(volume.get("label", "")).lower(),
                str(volume.get("actor_name", "")).lower(),
                str(volume.get("component_name", "")).lower(),
                str(volume.get("actor_path", "")).lower(),
            }
            if requested_name in candidates:
                selected = volume
                break

    result = {
        "success": True,
        "available": True,
        "operation": "inspect" if operation == "inspect" else "list",
        "count": len(volumes),
        "total_probes": sum(int(volume.get("probe_count", 0) or 0) for volume in volumes),
        "volumes": volumes,
        "selected": selected,
    }
    if operation == "inspect" and requested_name and selected is None:
        result["message"] = "No DDGI volume matched the requested name."
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
