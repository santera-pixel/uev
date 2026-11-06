def _load_material_instance(identifier):
    if not identifier:
        raise ValueError("asset_path or material_instance is required")
    asset = unreal.EditorAssetLibrary.load_asset(identifier)
    if not asset:
        raise ValueError("Could not load material instance '{0}'.".format(identifier))
    instance_class = getattr(unreal, "MaterialInstanceConstant", None)
    if instance_class and not isinstance(asset, instance_class):
        raise ValueError(
            "'{0}' is {1}, not a MaterialInstanceConstant.".format(
                identifier, asset.get_class().get_name()
            )
        )
    return asset



def _mcp_static_switch_library():
    """UEVMaterial supplies the material instance static switch writer 4.27 lacks."""
    library = getattr(unreal, "UEVMaterialLibrary", None)
    if library is not None and hasattr(library, "set_material_instance_static_switch"):
        return library
    return None


def _mcp_static_switch_json(payload):
    if not payload:
        return None
    try:
        import json as _mcp_json

        return _mcp_json.loads(str(payload))
    except Exception:
        return None


def _mcp_bool(value):
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on", "enabled")
    return bool(value)


def _parameter_names(instance, parameter_type):
    library = getattr(unreal, "MaterialEditingLibrary", None)
    function_name = "get_{0}_parameter_names".format(parameter_type)
    if not library or not hasattr(library, function_name):
        return []
    try:
        return [str(name) for name in getattr(library, function_name)(instance)]
    except Exception:
        return []


def _color_record(color):
    return {
        "r": float(color.r),
        "g": float(color.g),
        "b": float(color.b),
        "a": float(color.a),
    }


def inspect_material_instance(args):
    identifier = args.get("asset_path") or args.get("material_instance") or args.get("path")
    instance = _load_material_instance(identifier)
    library = getattr(unreal, "MaterialEditingLibrary", None)
    result = {
        "success": True,
        "operation": "inspect_material_instance",
        "asset_path": instance.get_path_name(),
        "parent": None,
        "scalar_parameters": {},
        "vector_parameters": {},
        "texture_parameters": {},
        "static_switch_parameters": {},
        "static_switch_overrides": {},
    }
    try:
        parent = instance.get_editor_property("parent")
        result["parent"] = parent.get_path_name() if parent else None
    except Exception:
        pass

    for name in _parameter_names(instance, "scalar"):
        try:
            result["scalar_parameters"][name] = float(
                library.get_material_instance_scalar_parameter_value(instance, name)
            )
        except Exception:
            result["scalar_parameters"][name] = None
    for name in _parameter_names(instance, "vector"):
        try:
            result["vector_parameters"][name] = _color_record(
                library.get_material_instance_vector_parameter_value(instance, name)
            )
        except Exception:
            result["vector_parameters"][name] = None
    for name in _parameter_names(instance, "texture"):
        try:
            texture = library.get_material_instance_texture_parameter_value(instance, name)
            result["texture_parameters"][name] = texture.get_path_name() if texture else None
        except Exception:
            result["texture_parameters"][name] = None
    static_switch_library = _mcp_static_switch_library()
    for name in _parameter_names(instance, "static_switch"):
        if static_switch_library is not None:
            payload = _mcp_static_switch_json(
                static_switch_library.get_material_instance_static_switch(instance, name)
            )
            if payload and payload.get("found"):
                result["static_switch_parameters"][name] = bool(payload.get("value"))
                result["static_switch_overrides"][name] = bool(
                    payload.get("overridden")
                )
                continue
        try:
            result["static_switch_parameters"][name] = bool(
                library.get_material_instance_static_switch_parameter_value(instance, name)
            )
        except Exception:
            result["static_switch_parameters"][name] = None
    return result


def set_material_instance_parameter(args):
    identifier = args.get("asset_path") or args.get("material_instance") or args.get("path")
    instance = _load_material_instance(identifier)
    parameter_name = args.get("parameter_name") or args.get("name")
    if not parameter_name:
        raise ValueError("parameter_name is required")
    parameter_type = (args.get("parameter_type") or "scalar").strip().lower()
    library = getattr(unreal, "MaterialEditingLibrary", None)
    if not library:
        raise ValueError("MaterialEditingLibrary is not exposed in this UE4.27 Python environment.")

    if parameter_type in ("scalar", "float"):
        library.set_material_instance_scalar_parameter_value(
            instance, parameter_name, float(args.get("value"))
        )
    elif parameter_type in ("vector", "color"):
        library.set_material_instance_vector_parameter_value(
            instance, parameter_name, as_linear_color(args.get("value"))
        )
    elif parameter_type == "texture":
        texture = unreal.EditorAssetLibrary.load_asset(args.get("value") or "")
        if not texture:
            raise ValueError("Could not load texture '{0}'.".format(args.get("value")))
        library.set_material_instance_texture_parameter_value(instance, parameter_name, texture)
    elif parameter_type in ("static_switch", "switch", "bool"):
        static_switch_library = _mcp_static_switch_library()
        if static_switch_library is not None:
            payload = _mcp_static_switch_json(
                static_switch_library.set_material_instance_static_switch(
                    instance, parameter_name, _mcp_bool(args.get("value"))
                )
            )
            if not payload or not payload.get("success"):
                message = payload.get("message") if payload else None
                raise ValueError(
                    message or "The static switch could not be written."
                )
        elif hasattr(library, "set_material_instance_static_switch_parameter_value"):
            library.set_material_instance_static_switch_parameter_value(
                instance, parameter_name, _mcp_bool(args.get("value"))
            )
        else:
            raise ValueError(
                "This engine exposes no static switch writer for material instances; "
                "the UEVMaterial native module is required."
            )
    else:
        raise ValueError("Unsupported parameter_type: {0}".format(parameter_type))

    library.update_material_instance(instance)
    save_loaded_editor_asset(instance)
    return {
        "success": True,
        "operation": "set_material_instance_parameter",
        "asset_path": instance.get_path_name(),
        "parameter_name": parameter_name,
        "parameter_type": parameter_type,
    }


def set_material_instance_parent(args):
    identifier = args.get("asset_path") or args.get("material_instance") or args.get("path")
    instance = _load_material_instance(identifier)
    parent_identifier = args.get("parent_material") or args.get("parent") or args.get("material_path")
    if not parent_identifier:
        raise ValueError("parent_material is required")
    parent = load_material_asset(parent_identifier)
    library = getattr(unreal, "MaterialEditingLibrary", None)
    if library and hasattr(library, "set_material_instance_parent"):
        library.set_material_instance_parent(instance, parent)
    else:
        set_object_property(instance, "parent", parent)
    if library:
        library.update_material_instance(instance)
    save_loaded_editor_asset(instance)
    return {
        "success": True,
        "operation": "set_material_instance_parent",
        "asset_path": instance.get_path_name(),
        "parent_material": parent.get_path_name(),
    }
