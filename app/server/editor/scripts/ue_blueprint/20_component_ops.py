import json


def _run_graph_operation(operation, args):
    """Call the C++ UEVGraphAuthoring library when the plugin is loaded.

    Returns None when the plugin is unavailable so the Python fallback can
    still be used on builds without UEVNative.
    """
    if not hasattr(unreal, "UEVGraphLibrary"):
        return None
    try:
        raw = unreal.UEVGraphLibrary.execute_graph_operation(
            "blueprint." + operation, json.dumps(args or {})
        )
        return json.loads(str(raw))
    except Exception as exc:
        return {"success": False, "message": str(exc)}


def add_component_to_blueprint(args):
    blueprint_name = args.get("blueprint_name")
    component_type = args.get("component_type")
    component_name = args.get("component_name")
    location = args.get("location")
    rotation = args.get("rotation")
    scale = args.get("scale")
    component_properties = args.get("component_properties") or {}
    parent_component_name = args.get("parent_component_name")

    try:
        blueprint = load_blueprint_asset(blueprint_name)
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    blueprint_asset_path = get_asset_package_name(blueprint) or str(blueprint_name)

    component_class = resolve_component_class(component_type)
    if not component_class:
        return {
            "success": False,
            "message": "Component class not found: {0}".format(component_type),
        }

    if not class_is_child_of(component_class, unreal.ActorComponent):
        return {
            "success": False,
            "message": "Class is not an ActorComponent: {0}".format(component_type),
        }

    if blueprint_has_component(blueprint, component_name):
        return {
            "success": False,
            "message": "Blueprint component already exists: {0}".format(component_name),
        }

    try:
        component_template = None
        component_node = None

        if (
            not blueprint_supports_scs_editing(blueprint)
            and not get_blueprint_construction_graph(blueprint)
            and not parent_component_name
        ):
            if supports_kismet_component_harvest():
                component_template = add_component_to_blueprint_via_harvest(
                    blueprint,
                    component_class,
                    component_name,
                    location=location,
                    rotation=rotation,
                    scale=scale,
                    component_properties=component_properties,
                )
            else:
                component_template = add_component_template_to_blueprint(
                    blueprint,
                    component_class,
                    component_name,
                    location=location,
                    rotation=rotation,
                    scale=scale,
                    component_properties=component_properties,
                )
        else:
            component_node = add_component_node_to_blueprint(
                blueprint,
                component_class,
                component_name,
                parent_component_name=parent_component_name,
            )
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    if component_template is None:
        component_template = get_scs_node_template(component_node)
        apply_scene_component_transform(component_template, location, rotation, scale)

        for property_name, property_value in component_properties.items():
            apply_component_property(component_template, property_name, property_value)

    finalize_blueprint_change(blueprint, structural=True)

    try:
        reloaded_blueprint = load_blueprint_asset(blueprint_asset_path)
    except Exception:
        reloaded_blueprint = blueprint

    try:
        component_node, component_template = get_component_template(
            reloaded_blueprint, component_name
        )
        blueprint = reloaded_blueprint
    except Exception as exc:
        return {
            "success": False,
            "message": "Blueprint component was not persisted after save/compile: {0}".format(
                exc
            ),
        }

    component_summary = {
        "name": component_name,
        "class": get_object_name(component_class),
    }
    if component_template is not None:
        component_summary = _component_summary(component_node, component_template)

    return {
        "success": True,
        "blueprint": get_asset_package_name(blueprint),
        "component": component_summary,
    }


def set_component_property(args):
    args = dict(args or {})
    blueprint_name = args.get("blueprint_name")
    component_name = args.get("component_name")
    property_name = args.get("property_name")
    property_value = args.get("property_value")

    plugin_result = _run_graph_operation(
        "set_component_property",
        {
            "blueprint_name": blueprint_name,
            "component_name": component_name,
            "property_name": property_name,
            "property_value": property_value,
            "save": args.get("save", True),
        },
    )
    if plugin_result is not None:
        return plugin_result

    try:
        blueprint = load_blueprint_asset(blueprint_name)
        component_node, component_template = get_component_template(
            blueprint, component_name
        )
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    if not property_name:
        return {"success": False, "message": "property_name is required"}

    if not apply_component_property(component_template, property_name, property_value):
        return {
            "success": False,
            "message": "Failed to set component property '{0}'".format(property_name),
        }

    finalize_blueprint_change(blueprint, structural=False)
    return {
        "success": True,
        "blueprint": get_asset_package_name(blueprint),
        "component": _component_summary(component_node, component_template),
    }


def set_static_mesh_properties(args):
    args = dict(args or {})
    plugin_result = _run_graph_operation(
        "set_static_mesh",
        {
            "blueprint_name": args.get("blueprint_name"),
            "component_name": args.get("component_name"),
            "static_mesh": args.get("static_mesh"),
            "save": args.get("save", True),
        },
    )
    if plugin_result is not None:
        return plugin_result

    args["property_name"] = "StaticMesh"
    args["property_value"] = args.get("static_mesh")
    return set_component_property(args)


def set_physics_properties(args):
    args = dict(args or {})
    blueprint_name = args.get("blueprint_name")
    component_name = args.get("component_name")

    plugin_args = {
        "blueprint_name": blueprint_name,
        "component_name": component_name,
        "save": args.get("save", True),
    }
    for field in (
        "simulate_physics",
        "gravity_enabled",
        "mass",
        "linear_damping",
        "angular_damping",
    ):
        if args.get(field) is not None:
            plugin_args[field] = args.get(field)

    plugin_result = _run_graph_operation("set_physics_properties", plugin_args)
    if plugin_result is not None:
        return plugin_result

    try:
        blueprint = load_blueprint_asset(blueprint_name)
        component_node, component_template = get_component_template(
            blueprint, component_name
        )
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    apply_component_property(
        component_template,
        "SimulatePhysics",
        args.get("simulate_physics", True),
    )
    apply_component_property(
        component_template,
        "EnableGravity",
        args.get("gravity_enabled", True),
    )
    apply_component_property(component_template, "Mass", args.get("mass", 1.0))
    apply_component_property(
        component_template,
        "LinearDamping",
        args.get("linear_damping", 0.01),
    )
    apply_component_property(
        component_template,
        "AngularDamping",
        args.get("angular_damping", 0.0),
    )

    finalize_blueprint_change(blueprint, structural=False)
    return {
        "success": True,
        "blueprint": get_asset_package_name(blueprint),
        "component": _component_summary(component_node, component_template),
    }
