import json


# ---------------------------------------------------------------------------
# 1.5.0 material lane helpers.
#
# These complement the shared prelude (ue_compat/35_material_instance_params.py)
# without changing it. Unreadable values are reported as null with a warning
# instead of being guessed.
# ---------------------------------------------------------------------------

_MG_MATERIAL_PROPERTY_INPUTS = [
    ("MP_BASE_COLOR", "base_color"),
    ("MP_METALLIC", "metallic"),
    ("MP_SPECULAR", "specular"),
    ("MP_ROUGHNESS", "roughness"),
    ("MP_EMISSIVE_COLOR", "emissive_color"),
    ("MP_OPACITY", "opacity"),
    ("MP_OPACITY_MASK", "opacity_mask"),
    ("MP_NORMAL", "normal"),
    ("MP_WORLD_POSITION_OFFSET", "world_position_offset"),
    ("MP_AMBIENT_OCCLUSION", "ambient_occlusion"),
    ("MP_REFRACTION", "refraction"),
    ("MP_PIXEL_DEPTH_OFFSET", "pixel_depth_offset"),
    ("MP_SHADING_MODEL", "shading_model"),
    ("MP_ANISOTROPY", "anisotropy"),
    ("MP_TANGENT", "tangent"),
]

_MG_USAGE_FLAGS = [
    ("used_with_skeletal_mesh", "skeletal_mesh"),
    ("used_with_editor_compositing", "editor_compositing"),
    ("used_with_particle_sprites", "particle_sprites"),
    ("used_with_beam_trails", "beam_trails"),
    ("used_with_mesh_particles", "mesh_particles"),
    ("used_with_niagara_sprites", "niagara_sprites"),
    ("used_with_niagara_ribbons", "niagara_ribbons"),
    ("used_with_niagara_mesh_particles", "niagara_mesh_particles"),
    ("used_with_geometry_cache", "geometry_cache"),
    ("used_with_static_lighting", "static_lighting"),
    ("used_with_morph_targets", "morph_targets"),
    ("used_with_spline_meshes", "spline_meshes"),
    ("used_with_instanced_static_meshes", "instanced_static_meshes"),
    ("used_with_geometry_collections", "geometry_collections"),
    ("used_with_clothing", "clothing"),
    ("used_with_water", "water"),
    ("used_with_water_caustics", "water_caustics"),
    ("used_with_hair_strands", "hair_strands"),
    ("used_with_tress_fx", "tress_fx"),
    ("used_with_lidar_point_cloud", "lidar_point_cloud"),
    ("used_with_virtual_heightfield_mesh", "virtual_heightfield_mesh"),
]

_MG_EXPRESSION_VALUE_PROPERTIES = [
    ("constant", "constant"),
    ("default_value", "default_value"),
    ("parameter_name", "parameter_name"),
    ("texture", "texture"),
    ("r", "r"),
    ("g", "g"),
    ("b", "b"),
    ("a", "a"),
    ("group", "group"),
    ("sort_priority", "sort_priority"),
]


def _mg_read_property(target, property_name):
    if target is None:
        return False, None

    try:
        return True, target.get_editor_property(property_name)
    except Exception:
        pass

    try:
        return True, getattr(target, property_name)
    except Exception:
        return False, None


def _mg_enum_name(value):
    if value is None:
        return None

    try:
        name = getattr(value, "name", None)
        if isinstance(name, str) and name:
            return name
    except Exception:
        pass

    text = str(value)
    if "." in text:
        text = text.rsplit(".", 1)[-1]
    return text


def _mg_color_record(color):
    if color is None:
        return None

    record = {}
    try:
        record["r"] = float(color.r)
        record["g"] = float(color.g)
        record["b"] = float(color.b)
        record["a"] = float(getattr(color, "a", 1.0))
    except Exception:
        return None
    return record


def _mg_object_record(value):
    if value is None:
        return None

    try:
        record = {"path": value.get_path_name()}
        class_name = get_object_class_name(value)
        if class_name:
            record["class"] = class_name
        return record
    except Exception:
        return None


def _mg_json_safe(value):
    if value is None or isinstance(value, (bool, int, str)):
        return value

    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value

    if isinstance(value, (list, tuple)):
        return [_mg_json_safe(entry) for entry in value]

    if isinstance(value, dict):
        return dict((str(key), _mg_json_safe(entry)) for key, entry in value.items())

    try:
        if hasattr(value, "r") and hasattr(value, "g") and hasattr(value, "b"):
            return _mg_color_record(value)
    except Exception:
        pass

    for axes in (("x", "y", "z"), ("x", "y"), ("pitch", "yaw", "roll")):
        if all(hasattr(value, axis) for axis in axes):
            try:
                return dict((axis, float(getattr(value, axis))) for axis in axes)
            except Exception:
                pass

    try:
        if hasattr(value, "get_path_name") and hasattr(value, "get_class"):
            return _mg_object_record(value) or str(value)
    except Exception:
        pass

    return str(value)


def _mg_safe_call(function, *call_args):
    try:
        return True, function(*call_args)
    except Exception as exc:
        return False, str(exc)


def _mg_is_material_function(asset):
    function_class = getattr(unreal, "MaterialFunction", None)
    if function_class is not None:
        try:
            return isinstance(asset, function_class)
        except Exception:
            pass
    return "MaterialFunction" in get_object_class_name(asset)


def _mg_load_graph_asset(args):
    identifier = (
        args.get("asset_path")
        or args.get("material_path")
        or args.get("function_path")
        or args.get("path")
        or args.get("name")
    )
    if not identifier:
        raise ValueError(
            "asset_path, material_path, function_path, path, or name is required"
        )

    asset = load_asset_by_identifier(identifier, ["Material", "MaterialFunction"])
    class_name = get_object_class_name(asset)

    material_class = getattr(unreal, "Material", None)
    function_class = getattr(unreal, "MaterialFunction", None)
    is_material = False
    is_function = False
    if material_class is not None:
        try:
            is_material = isinstance(asset, material_class)
        except Exception:
            is_material = False
    if function_class is not None:
        try:
            is_function = isinstance(asset, function_class)
        except Exception:
            is_function = False

    if not is_material and not is_function:
        is_function = "MaterialFunction" in class_name
        is_material = class_name == "Material"

    if not is_material and not is_function:
        raise ValueError(
            "'{0}' is a {1}, not a Material or MaterialFunction.".format(
                identifier, class_name or "non-material asset"
            )
        )
    return asset


def _mg_get_expressions(asset, is_function):
    property_name = "function_expressions" if is_function else "expressions"
    ok, expressions = _mg_read_property(asset, property_name)
    if not ok or expressions is None:
        return None
    return list(expressions)


def _mg_expression_inputs(expression):
    inputs = []
    input_class = getattr(unreal, "ExpressionInput", None)

    for attribute_name in dir(expression):
        if attribute_name.startswith("_"):
            continue
        try:
            value = getattr(expression, attribute_name)
        except Exception:
            continue

        is_input = False
        if input_class is not None:
            try:
                is_input = isinstance(value, input_class)
            except Exception:
                is_input = False
        if not is_input:
            is_input = type(value).__name__.lower().endswith("expressioninput")
        if not is_input:
            continue

        source_expression = getattr(value, "expression", None)
        inputs.append(
            {
                "name": attribute_name,
                "source": get_object_name(source_expression) if source_expression else "",
                "source_path": source_expression.get_path_name()
                if source_expression
                else None,
                "output_index": int(getattr(value, "output_index", 0) or 0),
            }
        )

    inputs.sort(key=lambda entry: entry["name"])
    return inputs


def _mg_expression_parameter_type(class_name):
    lowered = (class_name or "").lower()
    if "staticcomponentmask" in lowered:
        return "static_component_mask"
    if "staticswitch" in lowered:
        return "static_switch"
    if "scalarparameter" in lowered:
        return "scalar"
    if "vectorparameter" in lowered:
        return "vector"
    if "fontparameter" in lowered:
        return "font"
    if "runtimevirtualtexture" in lowered:
        return "runtime_virtual_texture"
    if "texture" in lowered and "parameter" in lowered:
        return "texture"
    return "unknown"


def _mg_expression_parameter(expression, class_name):
    ok, parameter_name = _mg_read_property(expression, "parameter_name")
    if not ok or not parameter_name:
        return None

    value = None
    for property_name in ("default_value", "value", "constant"):
        value_ok, candidate = _mg_read_property(expression, property_name)
        if value_ok and candidate is not None:
            value = _mg_json_safe(candidate)
            break

    return {
        "name": str(parameter_name),
        "type": _mg_expression_parameter_type(class_name),
        "value": value,
    }


def _mg_serialize_expression(expression):
    class_name = get_object_class_name(expression)
    record = {
        "name": get_object_name(expression),
        "class": class_name,
        "x": None,
        "y": None,
        "inputs": _mg_expression_inputs(expression),
        "outputs": [],
        "properties": {},
    }

    for property_name, key in (
        ("material_expression_editor_x", "x"),
        ("material_expression_editor_y", "y"),
    ):
        ok, value = _mg_read_property(expression, property_name)
        if ok and value is not None:
            try:
                record[key] = int(value)
            except Exception:
                record[key] = None

    for property_name, key in _MG_EXPRESSION_VALUE_PROPERTIES:
        ok, value = _mg_read_property(expression, property_name)
        if ok and value is not None:
            record["properties"][key] = _mg_json_safe(value)

    parameter = _mg_expression_parameter(expression, class_name)
    if parameter:
        record["parameter"] = parameter

    return record


def _mg_enrich_expression(record, expression):
    if not isinstance(record, dict):
        return record

    record.setdefault("properties", {})
    for property_name, key in _MG_EXPRESSION_VALUE_PROPERTIES:
        if key in record["properties"]:
            continue
        ok, value = _mg_read_property(expression, property_name)
        if ok and value is not None:
            record["properties"][key] = _mg_json_safe(value)

    if not record.get("inputs"):
        record["inputs"] = _mg_expression_inputs(expression)

    if not record.get("parameter"):
        parameter = _mg_expression_parameter(
            expression, record.get("class") or get_object_class_name(expression)
        )
        if parameter:
            record["parameter"] = parameter

    return record


def _mg_connections(expressions):
    connections = []
    for record in expressions or []:
        for expression_input in record.get("inputs") or []:
            if not expression_input.get("source"):
                continue
            connections.append(
                {
                    "from": expression_input["source"],
                    "output_index": expression_input.get("output_index", 0),
                    "to": record.get("name"),
                    "input": expression_input.get("name"),
                }
            )
    return connections


def _mg_material_property_inputs(material, warnings):
    library = getattr(unreal, "MaterialEditingLibrary", None)
    property_enum = getattr(unreal, "MaterialProperty", None)
    if library is None or property_enum is None:
        warnings.append(
            "MaterialEditingLibrary or unreal.MaterialProperty is not exposed; property inputs are unavailable."
        )
        return []

    inputs = []
    for enum_name, label in _MG_MATERIAL_PROPERTY_INPUTS:
        property_value = getattr(property_enum, enum_name, None)
        if property_value is None:
            continue
        ok, expression = _mg_safe_call(
            library.get_material_property_input_node, material, property_value
        )
        if not ok or expression is None:
            continue
        inputs.append(
            {"property": label, "expression": get_object_name(expression)}
        )
    return inputs


def _mg_material_properties(material):
    warnings = []
    properties = {
        "material_domain": None,
        "blend_mode": None,
        "decal_blend_mode": None,
        "shading_model": None,
        "two_sided": None,
        "opacity_mask_clip_value": None,
        "used_with": {},
        "used_with_any": [],
    }

    enum_properties = (
        ("material_domain", "material_domain"),
        ("blend_mode", "blend_mode"),
        ("decal_blend_mode", "decal_blend_mode"),
        ("shading_model", "shading_model"),
    )
    for property_name, key in enum_properties:
        ok, value = _mg_read_property(material, property_name)
        if ok and value is not None:
            properties[key] = _mg_enum_name(value)
        else:
            warnings.append(
                "Could not read material property '{0}'.".format(property_name)
            )

    for property_name, key in (
        ("two_sided", "two_sided"),
        ("opacity_mask_clip_value", "opacity_mask_clip_value"),
    ):
        ok, value = _mg_read_property(material, property_name)
        if ok and value is not None:
            try:
                properties[key] = bool(value) if key == "two_sided" else float(value)
            except Exception:
                properties[key] = None
        else:
            warnings.append(
                "Could not read material property '{0}'.".format(property_name)
            )

    for property_name, key in _MG_USAGE_FLAGS:
        ok, value = _mg_read_property(material, property_name)
        if not ok:
            continue
        try:
            enabled = bool(value)
        except Exception:
            continue
        properties["used_with"][key] = enabled
        if enabled:
            properties["used_with_any"].append(key)

    if not properties["used_with"]:
        warnings.append(
            "No bUsedWith* material usage flags were readable in this environment."
        )

    return properties, warnings


def _mg_material_parameters(material):
    library = getattr(unreal, "MaterialEditingLibrary", None)
    parameters = {
        "scalars": [],
        "vectors": [],
        "textures": [],
        "static_switches": [],
        "source": "MaterialEditingLibrary",
    }
    if library is None:
        parameters["source"] = None
        return parameters

    definitions = (
        (
            "scalars",
            "get_scalar_parameter_names",
            "get_material_default_scalar_parameter_value",
        ),
        (
            "vectors",
            "get_vector_parameter_names",
            "get_material_default_vector_parameter_value",
        ),
        (
            "textures",
            "get_texture_parameter_names",
            "get_material_default_texture_parameter_value",
        ),
        (
            "static_switches",
            "get_static_switch_parameter_names",
            "get_material_default_static_switch_parameter_value",
        ),
    )

    for bucket, names_function_name, value_function_name in definitions:
        names_function = getattr(library, names_function_name, None)
        value_function = getattr(library, value_function_name, None)
        if names_function is None:
            continue
        ok, names = _mg_safe_call(names_function, material)
        if not ok or names is None:
            continue
        for name in names:
            name = str(name)
            entry = {"name": name, "default": None}
            if value_function is not None:
                value_ok, value = _mg_safe_call(value_function, material, name)
                if value_ok:
                    entry["default"] = _mg_json_safe(value)
            parameters[bucket].append(entry)

    return parameters


def _mg_function_outputs(expressions, warnings):
    outputs = []
    for expression in expressions or []:
        if "FunctionOutput" not in get_object_class_name(expression):
            continue
        ok, name = _mg_read_property(expression, "output_name")
        outputs.append({"name": str(name) if ok and name else None})
    if not outputs:
        warnings.append("No MaterialExpressionFunctionOutput nodes were found.")
    return outputs


def _mg_native_graph(asset, args):
    library = getattr(unreal, "UEVGraphLibrary", None)
    if library is None or not hasattr(library, "execute_graph_operation"):
        return None, "UEVGraphLibrary is not loaded"

    payload = {"asset_path": asset.get_path_name()}

    try:
        raw_result = library.execute_graph_operation(
            "material.inspect_graph", json.dumps(payload)
        )
    except Exception as exc:
        return None, str(exc)

    try:
        result = json.loads(str(raw_result))
    except Exception:
        return None, "UEVGraphLibrary returned a non-JSON result"

    if not isinstance(result, dict):
        return None, "UEVGraphLibrary returned an unexpected result type"
    if result.get("success") is False:
        return None, result.get("message") or "native inspect_graph failed"
    return result, None


def _mg_graph_parameters_from_expressions(expressions):
    parameters = {
        "scalars": [],
        "vectors": [],
        "textures": [],
        "static_switches": [],
        "source": "expressions",
    }
    bucket_for_type = {
        "scalar": "scalars",
        "vector": "vectors",
        "texture": "textures",
        "static_switch": "static_switches",
    }
    for record in expressions or []:
        parameter = record.get("parameter")
        if not parameter:
            continue
        bucket = bucket_for_type.get(parameter.get("type"))
        if not bucket:
            continue
        parameters[bucket].append(
            {"name": parameter.get("name"), "default": parameter.get("value")}
        )
    return parameters


def inspect_graph(args):
    asset = _mg_load_graph_asset(args)
    is_function = _mg_is_material_function(asset)
    warnings = []

    result = {
        "success": True,
        "operation": "inspect_graph",
        "asset_path": asset.get_path_name(),
        "asset_name": get_object_name(asset),
        "asset_class": get_object_class_name(asset),
        "graph_type": "material_function" if is_function else "material",
        "expressions": [],
        "connections": [],
        "property_inputs": [],
        "function_outputs": [],
        "material_properties": None,
        "parameters": None,
        "warnings": warnings,
    }

    expressions = _mg_get_expressions(asset, is_function)
    native_result, native_error = _mg_native_graph(asset, args)

    if native_result:
        native_success = bool(native_result.get("success", True))
        native_message = native_result.get("message") or native_result.get("error")
        result.update(native_result)
        # The Python side already resolved and read the asset, so a native
        # failure is partial information, not a failed inspection.
        result["success"] = True
        result["source"] = "native+python"
        if native_error:
            warnings.append(native_error)
        if not native_success:
            warnings.append(
                "UEVGraphAuthoring inspect_graph reported a failure ({0}); expression, connection, and output data was reconstructed from Python where possible.".format(
                    native_message or "no message"
                )
            )
        if expressions is None:
            warnings.append(
                "Material expressions are not exposed through Python; expression values were not cross-checked."
            )
        else:
            records = result.get("expressions") or []
            records_by_name = dict(
                (record.get("name"), record)
                for record in records
                if isinstance(record, dict)
            )
            for expression in expressions:
                name = get_object_name(expression)
                record = records_by_name.get(name)
                if record is None:
                    record = _mg_serialize_expression(expression)
                    records.append(record)
                    records_by_name[name] = record
                _mg_enrich_expression(record, expression)
            result["expressions"] = records
    else:
        result["source"] = "python"
        if native_error:
            warnings.append(
                "UEVGraphAuthoring inspect_graph is unavailable ({0}); the graph is reconstructed from Python with limited output and link data.".format(
                    native_error
                )
            )
        if expressions is None:
            warnings.append(
                "Material expressions are not exposed through Python in this environment; the expression graph is unavailable."
            )
        else:
            result["expressions"] = [
                _mg_serialize_expression(expression) for expression in expressions
            ]

    result["connections"] = _mg_connections(result.get("expressions"))

    if is_function:
        if not result.get("function_outputs") and expressions is not None:
            result["function_outputs"] = _mg_function_outputs(expressions, warnings)
        result["parameters"] = _mg_graph_parameters_from_expressions(
            result.get("expressions")
        )
    else:
        if not result.get("property_inputs"):
            result["property_inputs"] = _mg_material_property_inputs(asset, warnings)
        result["material_properties"], property_warnings = _mg_material_properties(
            asset
        )
        warnings.extend(property_warnings)
        result["parameters"] = _mg_material_parameters(asset)

    result["complete"] = bool(
        expressions is not None
        and native_result is not None
        and (
            is_function
            or (
                result["material_properties"]
                and result["material_properties"].get("blend_mode") is not None
            )
        )
    )
    if not result["complete"] and not warnings:
        warnings.append("inspect_graph returned a partial result.")

    return result


# ---------------------------------------------------------------------------
# Material instance parameters: enrichment, bulk read, bulk write.
# ---------------------------------------------------------------------------

_legacy_inspect_material_instance = inspect_material_instance


def _mg_parameter_info_name(parameter_info):
    if parameter_info is None:
        return None
    ok, name = _mg_read_property(parameter_info, "name")
    if ok and name:
        return str(name)
    return None


def _mg_effective_entries(instance, parameter_type):
    """Read effective values by name when the override arrays are unreadable."""
    library = getattr(unreal, "MaterialEditingLibrary", None)
    if library is None:
        return []
    value_function = getattr(
        library, "get_material_instance_{0}_parameter_value".format(parameter_type), None
    )
    if value_function is None:
        return []
    entries = []
    for name in _parameter_names(instance, parameter_type):
        ok, value = _mg_safe_call(value_function, instance, name)
        record = {
            "name": name,
            "type": parameter_type,
            "value": None,
            "source": "effective",
        }
        if ok and value is not None:
            try:
                if parameter_type == "vector":
                    record["value"] = _mg_color_record(value)
                elif parameter_type == "texture":
                    record["value"] = value.get_path_name()
                elif parameter_type == "scalar":
                    record["value"] = float(value)
                else:
                    record["value"] = _mg_json_safe(value)
            except Exception:
                record["value"] = _mg_json_safe(value)
        elif not ok:
            record["warning"] = "Effective parameter value could not be read."
        entries.append(record)
    return entries


def _mg_effective_static_switches(instance):
    library = getattr(unreal, "MaterialEditingLibrary", None)
    if library is None:
        return []
    value_function = getattr(
        library, "get_material_instance_static_switch_parameter_value", None
    )
    if value_function is None:
        return []
    entries = []
    for name in _parameter_names(instance, "static_switch"):
        ok, value = _mg_safe_call(value_function, instance, name)
        record = {
            "name": name,
            "type": "static_switch",
            "value": None,
            "source": "effective",
        }
        if ok and value is not None:
            try:
                record["value"] = bool(value)
            except Exception:
                record["value"] = None
        elif not ok:
            record["warning"] = "Effective static switch value could not be read."
        entries.append(record)
    return entries


def _mg_instance_overrides(instance, warnings):
    overrides = {
        "scalars": [],
        "vectors": [],
        "textures": [],
        "static_switches": [],
    }

    definitions = (
        ("scalars", "scalar_parameter_values", "parameter_value", "scalar"),
        ("vectors", "vector_parameter_values", "parameter_value", "vector"),
        ("textures", "texture_parameter_values", "parameter_value", "texture"),
    )

    for bucket, property_name, value_property, parameter_type in definitions:
        ok, entries = _mg_read_property(instance, property_name)
        if not ok or entries is None:
            effective = _mg_effective_entries(instance, parameter_type)
            if effective:
                overrides[bucket].extend(effective)
                warnings.append(
                    "Could not read '{0}'; {1} values are effective values (source=effective), not overrides.".format(
                        property_name, parameter_type
                    )
                )
            else:
                warnings.append(
                    "Could not read '{0}'; {1} overrides are incomplete.".format(
                        property_name, parameter_type
                    )
                )
            continue
        for entry in entries:
            info_ok, parameter_info = _mg_read_property(entry, "parameter_info")
            name = _mg_parameter_info_name(parameter_info) if info_ok else None
            value_ok, value = _mg_read_property(entry, value_property)
            record = {
                "name": name,
                "type": parameter_type,
                "value": _mg_json_safe(value) if value_ok else None,
            }
            if not value_ok:
                record["warning"] = "Parameter value could not be read."
            overrides[bucket].append(record)

    native_switches = _mg_native_static_switches(instance)
    if native_switches is not None:
        overrides["static_switches"].extend(native_switches)
        return overrides

    ok, static_parameters = _mg_read_property(instance, "static_parameters")
    if not ok or static_parameters is None:
        effective_switches = _mg_effective_static_switches(instance)
        if effective_switches:
            overrides["static_switches"].extend(effective_switches)
            warnings.append(
                "Static switch overrides are not exposed on this MaterialInstanceConstant; effective static switch values are reported instead (source=effective)."
            )
        else:
            warnings.append(
                "Static switch overrides are not exposed on this MaterialInstanceConstant; static switch values were not read."
            )
    else:
        list_ok, entries = _mg_read_property(
            static_parameters, "static_switch_parameter_values"
        )
        if not list_ok or entries is None:
            warnings.append(
                "Could not read static switch overrides from static_parameters."
            )
        else:
            for entry in entries:
                info_ok, parameter_info = _mg_read_property(entry, "parameter_info")
                value_ok, value = _mg_read_property(entry, "value")
                switch_value = None
                if value_ok and value is not None:
                    try:
                        switch_value = bool(value)
                    except Exception:
                        switch_value = None
                overrides["static_switches"].append(
                    {
                        "name": _mg_parameter_info_name(parameter_info)
                        if info_ok
                        else None,
                        "type": "static_switch",
                        "value": switch_value,
                    }
                )

    return overrides


def inspect_material_instance(args):
    result = _legacy_inspect_material_instance(args)
    warnings = result.get("warnings")
    if not isinstance(warnings, list):
        warnings = []
        result["warnings"] = warnings

    identifier = (
        args.get("asset_path")
        or args.get("material_instance")
        or args.get("path")
        or args.get("instance_path")
    )
    try:
        instance = _load_material_instance(identifier)
        overrides = _mg_instance_overrides(instance, warnings)
        result["overrides"] = overrides
        result["parameter_counts"] = {
            "scalars": len(overrides["scalars"]),
            "vectors": len(overrides["vectors"]),
            "textures": len(overrides["textures"]),
            "static_switches": len(overrides["static_switches"]),
        }
    except Exception as exc:
        result["overrides"] = None
        result["parameter_counts"] = None
        warnings.append("Could not read parameter overrides: {0}".format(exc))

    return result


def get_material_instance_parameters(args):
    identifier = (
        args.get("instance_path")
        or args.get("asset_path")
        or args.get("material_instance")
        or args.get("path")
    )
    instance = _load_material_instance(identifier)
    warnings = []
    overrides = _mg_instance_overrides(instance, warnings)

    entries = []
    for bucket in ("scalars", "vectors", "textures", "static_switches"):
        for override in overrides[bucket]:
            entries.append(
                {
                    "name": override.get("name"),
                    "type": override.get("type"),
                    "value": override.get("value"),
                    "overridden": True,
                }
            )

    result = {
        "success": True,
        "operation": "get_material_instance_parameters",
        "asset_path": instance.get_path_name(),
        "parent": None,
        "overrides": overrides,
        "parameters": entries,
        "summary": {
            "total": len(entries),
            "scalars": len(overrides["scalars"]),
            "vectors": len(overrides["vectors"]),
            "textures": len(overrides["textures"]),
            "static_switches": len(overrides["static_switches"]),
        },
        "warnings": warnings,
    }

    try:
        parent = instance.get_editor_property("parent")
        result["parent"] = parent.get_path_name() if parent else None
    except Exception:
        warnings.append("Could not read the material instance parent.")

    try:
        effective = _legacy_inspect_material_instance(
            {"asset_path": instance.get_path_name()}
        )
        result["effective_parameters"] = {
            "scalars": effective.get("scalar_parameters") or {},
            "vectors": effective.get("vector_parameters") or {},
            "textures": effective.get("texture_parameters") or {},
            "static_switches": effective.get("static_switch_parameters") or {},
        }
    except Exception as exc:
        result["effective_parameters"] = None
        warnings.append("Could not read effective parameter values: {0}".format(exc))

    return result


_legacy_set_material_instance_parameter = set_material_instance_parameter

_STATIC_SWITCH_TYPES = ("static_switch", "static_switch_value", "switch", "bool", "boolean")
_TRUE_WORDS = ("true", "1", "yes", "on", "enabled")
_FALSE_WORDS = ("false", "0", "no", "off", "disabled")


def _mg_coerce_bool(value, name):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _TRUE_WORDS:
            return True
        if normalized in _FALSE_WORDS:
            return False
    raise ValueError(
        "Static switch '{0}' expects true or false, got {1!r}.".format(name, value)
    )


_MG_NATIVE_MATERIAL_STATE = {"checked": False, "library": None}


def _mg_native_material_library():
    """UEVMaterial exposes material instance writes that the 4.27 Python API lacks.

    UE 4.27's MaterialEditingLibrary can read a MaterialInstanceConstant static switch
    but has no setter for it, so the native UEVMaterial module owns that write.
    """
    if not _MG_NATIVE_MATERIAL_STATE["checked"]:
        _MG_NATIVE_MATERIAL_STATE["checked"] = True
        candidate = getattr(unreal, "UEVMaterialLibrary", None)
        if candidate is not None and hasattr(
            candidate, "set_material_instance_static_switch"
        ):
            _MG_NATIVE_MATERIAL_STATE["library"] = candidate
    return _MG_NATIVE_MATERIAL_STATE["library"]


def _mg_native_material_call(function_name, *args):
    library = _mg_native_material_library()
    if library is None:
        return None
    function = getattr(library, function_name, None)
    if function is None:
        return None
    try:
        payload = function(*args)
    except Exception:
        return None
    if not payload:
        return None
    try:
        return json.loads(str(payload))
    except Exception:
        return None


def _mg_native_static_switches(instance):
    """[{name, type, value, overridden, source}] from UEVMaterial, or None when unavailable."""
    payload = _mg_native_material_call(
        "list_material_instance_static_switches", instance
    )
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    entries = []
    for switch in payload.get("switches") or []:
        entries.append(
            {
                "name": switch.get("name"),
                "type": "static_switch",
                "value": bool(switch.get("value")),
                "overridden": bool(switch.get("overridden")),
                "source": "instance",
            }
        )
    return entries


def set_material_instance_parameter(args):
    requested_type = (args.get("parameter_type") or "scalar").strip().lower()
    parameter_type = (
        "static_switch" if requested_type in _STATIC_SWITCH_TYPES else requested_type
    )
    normalized = dict(args)
    normalized["parameter_type"] = parameter_type
    if parameter_type == "static_switch":
        normalized["value"] = _mg_coerce_bool(
            args.get("value"), str(args.get("parameter_name") or args.get("name") or "")
        )

    name = str(args.get("parameter_name") or "").strip()
    if not name:
        raise ValueError("parameter_name is required.")
    identifier = (
        args.get("asset_path")
        or args.get("material_instance")
        or args.get("instance_path")
        or args.get("path")
    )
    instance = _load_material_instance(identifier)
    warnings = []
    known = _mg_known_parameter_names(instance, parameter_type, warnings)
    read_failures = [warning for warning in warnings if warning.startswith("Could not read")]
    if name not in known and not read_failures:
        raise ValueError(
            "Parameter '{0}' is not defined on {1} or its parent. Available {2} parameters: {3}. "
            "Use set_material_instance_parameters to write several parameters at once and get per-parameter warnings.".format(
                name,
                identifier,
                parameter_type,
                ", ".join(sorted(known)[:24]) or "(none)",
            )
        )
    return _legacy_set_material_instance_parameter(normalized)


def _mg_coerce_color(value):
    if isinstance(value, dict):
        return unreal.LinearColor(
            r=float(value.get("r", value.get("R", 1.0))),
            g=float(value.get("g", value.get("G", 1.0))),
            b=float(value.get("b", value.get("B", 1.0))),
            a=float(value.get("a", value.get("A", 1.0))),
        )

    if isinstance(value, str):
        text = value.strip()
        if text.startswith("#"):
            text = text[1:]
        if len(text) in (6, 8):
            try:
                red = int(text[0:2], 16) / 255.0
                green = int(text[2:4], 16) / 255.0
                blue = int(text[4:6], 16) / 255.0
                alpha = int(text[6:8], 16) / 255.0 if len(text) == 8 else 1.0
                return unreal.LinearColor(r=red, g=green, b=blue, a=alpha)
            except ValueError:
                pass
        raise ValueError(
            "Vector value '{0}' is not a color. Use {{r,g,b,a}}, [r,g,b,a], or #RRGGBB / #RRGGBBAA.".format(
                value
            )
        )

    if isinstance(value, (list, tuple)):
        if len(value) not in (3, 4):
            raise ValueError(
                "Vector value must have 3 or 4 components, got {0}.".format(len(value))
            )
        return unreal.LinearColor(
            r=float(value[0]),
            g=float(value[1]),
            b=float(value[2]),
            a=float(value[3]) if len(value) > 3 else 1.0,
        )

    raise ValueError(
        "Vector value must be {{r,g,b,a}}, [r,g,b,a], or a hex color string."
    )


def _mg_colors_close(left, right, tolerance=1e-4):
    if left is None or right is None:
        return False
    try:
        return (
            abs(float(left.r) - float(right.r)) <= tolerance
            and abs(float(left.g) - float(right.g)) <= tolerance
            and abs(float(left.b) - float(right.b)) <= tolerance
            and abs(float(left.a) - float(right.a)) <= tolerance
        )
    except Exception:
        return False


def _mg_known_parameter_names(instance, parameter_type, warnings):
    bucket = {
        "scalar": "scalars",
        "vector": "vectors",
        "texture": "textures",
        "static_switch": "static_switches",
    }[parameter_type]
    names = set(str(name) for name in _parameter_names(instance, parameter_type))
    try:
        overrides = _mg_instance_overrides(instance, [])
    except Exception as exc:
        warnings.append(
            "Could not read overrides while checking {0} names: {1}".format(
                parameter_type, exc
            )
        )
        overrides = {}
    for entry in overrides.get(bucket) or []:
        if entry.get("name"):
            names.add(str(entry["name"]))

    parent = None
    try:
        parent = instance.get_editor_property("parent")
    except Exception:
        parent = None
    if parent:
        try:
            definitions = _mg_material_parameters(parent).get(bucket) or []
        except Exception as exc:
            warnings.append(
                "Could not read parent material parameters while checking {0} names: {1}".format(
                    parameter_type, exc
                )
            )
            definitions = []
        for entry in definitions:
            if entry.get("name"):
                names.add(str(entry["name"]))
    return names


def _mg_set_scalar(instance, library, name, value, results, known_names):
    result = {"name": name, "type": "scalar", "requested": None, "applied": None}
    try:
        result["requested"] = float(value)
    except Exception:
        result.update({"success": False, "message": "Scalar value must be a number."})
        results.append(result)
        return

    if known_names and name not in known_names:
        result["warning"] = (
            "Parameter '{0}' is not listed on this instance or its parent (typo or unused parameter?).".format(
                name
            )
        )

    ok, previous = _mg_safe_call(
        library.get_material_instance_scalar_parameter_value, instance, name
    )
    if ok and previous is not None:
        try:
            result["previous"] = float(previous)
        except Exception:
            result["previous"] = None

    ok, outcome = _mg_safe_call(
        library.set_material_instance_scalar_parameter_value,
        instance,
        name,
        result["requested"],
    )
    if not ok:
        result.update({"success": False, "message": str(outcome)})
        results.append(result)
        return

    read_ok, applied = _mg_safe_call(
        library.get_material_instance_scalar_parameter_value, instance, name
    )
    if read_ok and applied is not None:
        try:
            result["applied"] = float(applied)
            result["success"] = abs(result["applied"] - result["requested"]) <= 1e-5
        except Exception:
            result["applied"] = None
            result["success"] = False
    else:
        result["success"] = bool(outcome)
    if not result["success"]:
        result["message"] = "Engine did not apply the scalar value."
    results.append(result)


def _mg_set_vector(instance, library, name, value, results, known_names):
    result = {"name": name, "type": "vector", "requested": None, "applied": None}
    try:
        color = _mg_coerce_color(value)
    except ValueError as exc:
        result.update({"success": False, "message": str(exc)})
        results.append(result)
        return

    result["requested"] = _mg_color_record(color)
    if known_names and name not in known_names:
        result["warning"] = (
            "Parameter '{0}' is not listed on this instance or its parent (typo or unused parameter?).".format(
                name
            )
        )

    ok, previous = _mg_safe_call(
        library.get_material_instance_vector_parameter_value, instance, name
    )
    if ok:
        result["previous"] = _mg_color_record(previous)

    ok, outcome = _mg_safe_call(
        library.set_material_instance_vector_parameter_value, instance, name, color
    )
    if not ok:
        result.update({"success": False, "message": str(outcome)})
        results.append(result)
        return

    read_ok, applied = _mg_safe_call(
        library.get_material_instance_vector_parameter_value, instance, name
    )
    if read_ok:
        result["applied"] = _mg_color_record(applied)
        result["success"] = _mg_colors_close(applied, color)
    else:
        result["success"] = bool(outcome)
    if not result["success"]:
        result["message"] = "Engine did not apply the vector value."
    results.append(result)


def _mg_set_texture(instance, library, name, value, results, known_names):
    result = {"name": name, "type": "texture", "requested": value, "applied": None}
    if not isinstance(value, str) or not value.strip():
        result.update(
            {"success": False, "message": "Texture value must be an asset path."}
        )
        results.append(result)
        return

    try:
        texture = unreal.EditorAssetLibrary.load_asset(value)
    except Exception as exc:
        result.update({"success": False, "message": str(exc)})
        results.append(result)
        return
    if not texture:
        result.update(
            {"success": False, "message": "Could not load texture '{0}'.".format(value)}
        )
        results.append(result)
        return

    if known_names and name not in known_names:
        result["warning"] = (
            "Parameter '{0}' is not listed on this instance or its parent (typo or unused parameter?).".format(
                name
            )
        )

    ok, previous = _mg_safe_call(
        library.get_material_instance_texture_parameter_value, instance, name
    )
    if ok and previous is not None:
        result["previous"] = previous.get_path_name()

    ok, outcome = _mg_safe_call(
        library.set_material_instance_texture_parameter_value, instance, name, texture
    )
    if not ok:
        result.update({"success": False, "message": str(outcome)})
        results.append(result)
        return

    read_ok, applied = _mg_safe_call(
        library.get_material_instance_texture_parameter_value, instance, name
    )
    if read_ok and applied is not None:
        result["applied"] = applied.get_path_name()
        result["success"] = result["applied"] == texture.get_path_name()
        if not result["success"]:
            result["message"] = "Engine returned a different texture than requested."
    else:
        result["success"] = bool(outcome)
    results.append(result)


def _mg_set_static_switch(instance, library, name, value, results, known_names):
    result = {
        "name": name,
        "type": "static_switch",
        "requested": None,
        "applied": None,
    }
    try:
        result["requested"] = _mg_coerce_bool(value, name)
    except ValueError as exc:
        result.update({"success": False, "message": str(exc)})
        results.append(result)
        return

    if known_names and name not in known_names:
        result["warning"] = (
            "Parameter '{0}' is not listed on this instance or its parent (typo or unused parameter?).".format(
                name
            )
        )

    native = _mg_native_material_library()
    if native is not None:
        previous = _mg_native_material_call(
            "get_material_instance_static_switch", instance, name
        )
        if isinstance(previous, dict) and previous.get("found"):
            result["previous"] = bool(previous.get("value"))
        payload = _mg_native_material_call(
            "set_material_instance_static_switch", instance, name, result["requested"]
        )
        if not isinstance(payload, dict) or not payload.get("success"):
            message = payload.get("message") if isinstance(payload, dict) else None
            result.update(
                {
                    "success": False,
                    "message": message
                    or "The static switch could not be written.",
                }
            )
            results.append(result)
            return
        result["applied"] = bool(payload.get("applied"))
        result["overridden"] = bool(payload.get("applied_overridden"))
        result["success"] = result["applied"] == result["requested"]
        result["message"] = (
            "Static switch updated."
            if result["success"]
            else "Engine did not apply the static switch value."
        )
        results.append(result)
        return

    setter = getattr(
        library, "set_material_instance_static_switch_parameter_value", None
    )
    if setter is None:
        result.update(
            {
                "success": False,
                "message": "This engine exposes no static switch writer for material instances; the UEVMaterial native module is required.",
            }
        )
        results.append(result)
        return

    ok, previous = _mg_safe_call(
        library.get_material_instance_static_switch_parameter_value, instance, name
    )
    if ok and previous is not None:
        try:
            result["previous"] = bool(previous)
        except Exception:
            result["previous"] = None

    ok, outcome = _mg_safe_call(
        setter,
        instance,
        name,
        result["requested"],
    )
    if not ok:
        result.update({"success": False, "message": str(outcome)})
        results.append(result)
        return

    read_ok, applied = _mg_safe_call(
        library.get_material_instance_static_switch_parameter_value, instance, name
    )
    if read_ok and applied is not None:
        result["applied"] = bool(applied)
        result["success"] = result["applied"] == result["requested"]
    else:
        result["success"] = bool(outcome)
    if not result["success"]:
        result["message"] = "Engine did not apply the static switch value."
    results.append(result)


def set_material_instance_parameters(args):
    identifier = (
        args.get("instance_path")
        or args.get("asset_path")
        or args.get("material_instance")
        or args.get("path")
    )
    instance = _load_material_instance(identifier)

    library = getattr(unreal, "MaterialEditingLibrary", None)
    if library is None:
        raise ValueError(
            "MaterialEditingLibrary is not exposed in this UE4.27 Python environment."
        )

    scalars = args.get("scalars") or {}
    vectors = args.get("vectors") or {}
    textures = args.get("textures") or {}
    static_switches = args.get("static_switches") or {}
    if not scalars and not vectors and not textures and not static_switches:
        raise ValueError(
            "Provide at least one of scalars, vectors, textures, or static_switches to update."
        )

    warnings = []
    results = []
    scalar_names = _mg_known_parameter_names(instance, "scalar", warnings)
    vector_names = _mg_known_parameter_names(instance, "vector", warnings)
    texture_names = _mg_known_parameter_names(instance, "texture", warnings)
    static_switch_names = _mg_known_parameter_names(instance, "static_switch", warnings)

    for name, value in scalars.items():
        _mg_set_scalar(instance, library, str(name), value, results, scalar_names)
    for name, value in vectors.items():
        _mg_set_vector(instance, library, str(name), value, results, vector_names)
    for name, value in textures.items():
        _mg_set_texture(instance, library, str(name), value, results, texture_names)
    for name, value in static_switches.items():
        _mg_set_static_switch(
            instance, library, str(name), value, results, static_switch_names
        )

    succeeded = [entry for entry in results if entry.get("success")]
    failed = [entry for entry in results if not entry.get("success")]

    updated = False
    if succeeded:
        ok, outcome = _mg_safe_call(library.update_material_instance, instance)
        if not ok:
            warnings.append("update_material_instance failed: {0}".format(outcome))
        else:
            updated = True

    saved = False
    save_requested = bool(args.get("save"))
    if updated and save_requested:
        ok, outcome = _mg_safe_call(save_loaded_editor_asset, instance)
        if ok:
            saved = bool(outcome) if outcome is not None else True
        else:
            warnings.append("Saving the material instance failed: {0}".format(outcome))

    summary = {
        "total": len(results),
        "succeeded": len(succeeded),
        "failed": len(failed),
        "updated": updated,
        "save_requested": save_requested,
        "saved": saved,
    }

    result = {
        "success": len(failed) == 0,
        "partial": bool(succeeded) and bool(failed),
        "operation": "set_material_instance_parameters",
        "asset_path": instance.get_path_name(),
        "results": results,
        "summary": summary,
        "warnings": warnings,
    }
    if succeeded and not saved:
        result["warnings"].append(
            "Parameter values were updated in memory but the asset was not saved (pass save=true to persist)."
        )
    return result


OPERATIONS = {
    "spawn_physics_blueprint_actor": spawn_physics_blueprint_actor,
    "get_available_materials": get_available_materials,
    "apply_material_to_actor": apply_material_to_actor,
    "apply_material_to_blueprint": apply_material_to_blueprint,
    "set_mesh_material_color": set_mesh_material_color,
    "create_material_instance": create_material_instance,
    "inspect_material_instance": inspect_material_instance,
    "inspect_graph": inspect_graph,
    "get_material_instance_parameters": get_material_instance_parameters,
    "set_material_instance_parameter": set_material_instance_parameter,
    "set_material_instance_parameters": set_material_instance_parameters,
    "set_material_instance_parent": set_material_instance_parent,
}


def main():
    operation = decode_template_json("""${operation}""")
    args = decode_template_json("""${args}""")

    handler = OPERATIONS.get(operation)
    if not handler:
        print(
            json.dumps(
                {
                    "success": False,
                    "message": "Unknown material tool operation: {0}".format(operation),
                },
                indent=2,
            )
        )
        return

    try:
        result = handler(args or {})
    except Exception as exc:
        result = {"success": False, "message": str(exc)}

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
