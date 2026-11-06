def _component_summary(node, component_template):
    summary = {
        "name": get_scs_node_name(node) if node else get_object_name(component_template),
        "class": get_object_class_name(component_template),
    }

    if class_is_child_of(component_template.get_class(), unreal.SceneComponent):
        try:
            relative_location = component_template.get_relative_location()
            summary["location"] = {
                "x": relative_location.x,
                "y": relative_location.y,
                "z": relative_location.z,
            }
        except Exception:
            pass

        try:
            relative_rotation = component_template.get_relative_rotation()
            summary["rotation"] = {
                "pitch": relative_rotation.pitch,
                "yaw": relative_rotation.yaw,
                "roll": relative_rotation.roll,
            }
        except Exception:
            pass

        try:
            relative_scale = component_template.get_relative_scale3d()
            summary["scale"] = {
                "x": relative_scale.x,
                "y": relative_scale.y,
                "z": relative_scale.z,
            }
        except Exception:
            pass

    return summary
