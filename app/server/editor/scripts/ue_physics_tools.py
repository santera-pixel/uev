"""Physics tooling for the manage_physics namespace.

The two longstanding operations (spawn_physics_blueprint_actor, set_physics_properties)
stay in the material and blueprint scripts so existing behaviour is untouched. This
script owns the additional physics operations from the 1.5.0 design (section 9.11):
PIE force/impulse/torque application, collision profile and response editing,
character movement defaults, and the PIE drop assertion.

Persistence policy for Blueprint changes (documented because it is a deliberate
trade-off, not an accident):
  * edits made to a SimpleConstructionScript template require one Blueprint compile
    before the CDO picks the value up, so those paths call try_compile_blueprint once;
  * edits made directly to a CDO subobject (for example a Character Blueprint's
    CharacterMovementComponent) do not need a compile and skip it, which avoids
    resetting the very defaults that were just written;
  * saving is controlled by the caller's "save" flag (default true) and always goes
    through save_loaded_editor_asset.

Only helpers from the shared ue_compat prelude are used; this script is rendered with
the compat prelude and nothing else.
"""

import json
import time


_COLLISION_CHANNEL_VALUES = {
    "worldstatic": 0,
    "worlddynamic": 1,
    "pawn": 2,
    "visibility": 3,
    "camera": 4,
    "physicsbody": 5,
    "vehicle": 6,
    "destructible": 7,
}

_COLLISION_CHANNEL_LABELS = {
    "worldstatic": "WorldStatic",
    "worlddynamic": "WorldDynamic",
    "pawn": "Pawn",
    "visibility": "Visibility",
    "camera": "Camera",
    "physicsbody": "PhysicsBody",
    "vehicle": "Vehicle",
    "destructible": "Destructible",
}

_COLLISION_RESPONSE_VALUES = {
    "ignore": 0,
    "overlap": 1,
    "block": 2,
}

_COLLISION_RESPONSE_LABELS = {
    0: "ignore",
    1: "overlap",
    2: "block",
}

_MOVEMENT_PROPERTIES = (
    ("max_walk_speed", "max_walk_speed", 0.0, None),
    ("jump_z_velocity", "jump_z_velocity", 0.0, None),
    ("gravity_scale", "gravity_scale", 0.0, None),
    ("air_control", "air_control", 0.0, 1.0),
    ("braking_deceleration", "braking_deceleration_walking", 0.0, None),
    ("ground_friction", "ground_friction", 0.0, None),
    ("max_step_height", "max_step_height", 0.0, None),
    ("walkable_floor_angle", "walkable_floor_angle", 0.0, 89.9),
)

_DROP_TEST_MAX_WALL_SECONDS = 5.0
_DROP_TEST_DEFAULT_WALL_SECONDS = 1.5
_DROP_TEST_DEFAULT_FRAMES = 60
_DROP_TEST_MAX_FRAMES = 240
_DROP_TEST_SAMPLE_INTERVAL_SECONDS = 0.02
_DROP_TEST_RESTING_TOLERANCE_CM = 2.0
_DROP_TEST_RESTING_SPEED_TOLERANCE = 5.0
_DROP_TEST_FELL_THROUGH_MARGIN_CM = 5.0
_GROUND_TRACE_START_Z = 20000.0
_GROUND_TRACE_END_Z = -20000.0


# ---------------------------------------------------------------------------
# generic argument helpers
# ---------------------------------------------------------------------------


def _run_graph_operation(operation, args):
    if not hasattr(unreal, "UEVGraphLibrary"):
        return None
    try:
        raw = unreal.UEVGraphLibrary.execute_graph_operation(
            "blueprint." + operation, json.dumps(args or {})
        )
        return json.loads(str(raw))
    except Exception as exc:
        return {"success": False, "message": str(exc)}


def _run_gameplay_operation(operation, args):
    if not hasattr(unreal, "UEVGraphLibrary"):
        return None
    try:
        raw = unreal.UEVGraphLibrary.execute_graph_operation(
            "gameplay." + operation, json.dumps(args or {})
        )
        return json.loads(str(raw))
    except Exception as exc:
        return {"success": False, "message": str(exc)}


def _failure(message, **extra):
    result = {"success": False, "message": message}
    result.update(extra)
    return result


def _first_value(args, keys):
    for key in keys:
        value = args.get(key)
        if value is not None:
            return value
    return None


def _first_string(args, keys):
    for key in keys:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _required_string(args, key):
    value = _first_string(args, (key,))
    if not value:
        raise ValueError("Missing required argument: {0}".format(key))
    return value


def _optional_float(args, key):
    value = args.get(key)
    if value is None or value == "":
        return None
    try:
        return float(value)
    except Exception:
        raise ValueError("Argument '{0}' must be a number.".format(key))


def _optional_bool(args, key, default):
    value = args.get(key)
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes"):
            return True
        if lowered in ("false", "0", "no"):
            return False
    return bool(value)


def _vector_arg(values, label):
    components = None
    if isinstance(values, dict):
        components = [values.get("x"), values.get("y"), values.get("z")]
    elif isinstance(values, (list, tuple)) and len(values) >= 3:
        components = list(values)[:3]

    if components is None:
        raise ValueError(
            "Argument '{0}' must be a three component vector.".format(label)
        )

    numbers = []
    for component in components:
        try:
            numbers.append(float(component))
        except Exception:
            raise ValueError(
                "Argument '{0}' must contain numeric x, y and z components.".format(
                    label
                )
            )

    return unreal.Vector(numbers[0], numbers[1], numbers[2])


def _fname(value):
    text = str(value or "").strip()
    try:
        return unreal.Name(text if text else "None")
    except Exception:
        return text


def _round(value, digits=3):
    try:
        return round(float(value), digits)
    except Exception:
        return None


def _round_vector(vector, digits=3):
    if vector is None:
        return None
    return [
        _round(getattr(vector, "x", None), digits),
        _round(getattr(vector, "y", None), digits),
        _round(getattr(vector, "z", None), digits),
    ]


def _enum_ordinal(value):
    if value is None:
        return None
    try:
        return int(value)
    except Exception:
        pass
    try:
        return int(value.value)
    except Exception:
        pass
    text = str(value).upper()
    if "BLOCK" in text:
        return 2
    if "OVERLAP" in text:
        return 1
    if "IGNORE" in text:
        return 0
    return None


def _resolve_enum(enum_name, candidates, fallback_index):
    enum_class = getattr(unreal, enum_name, None)
    if enum_class is None:
        return None
    for candidate in candidates:
        try:
            value = getattr(enum_class, candidate)
            if value is not None:
                return value
        except Exception:
            continue
    if fallback_index is None:
        return None

    try:
        return enum_class(fallback_index)
    except Exception:
        return None


def _collision_channel_key(channel_name):
    key = str(channel_name or "").strip().lower().replace("_", "").replace(" ", "")
    if key not in _COLLISION_CHANNEL_VALUES:
        raise ValueError(
            "Unknown collision channel '{0}'. Use one of: {1}".format(
                channel_name, ", ".join(_COLLISION_CHANNEL_LABELS.values())
            )
        )
    return key


def _collision_response_key(response_name):
    key = str(response_name or "").strip().lower()
    if key not in _COLLISION_RESPONSE_VALUES:
        raise ValueError(
            "Unknown collision response '{0}'. Use one of: ignore, overlap, block.".format(
                response_name
            )
        )
    return key


def _resolve_collision_channel(channel_name):
    key = str(channel_name or "").strip().lower().replace("_", "").replace(" ", "")
    if key not in _COLLISION_CHANNEL_VALUES:
        raise ValueError(
            "Unknown collision channel '{0}'. Use one of: {1}".format(
                channel_name, ", ".join(_COLLISION_CHANNEL_LABELS.values())
            )
        )

    label = _COLLISION_CHANNEL_LABELS[key]
    channel = _resolve_enum(
        "CollisionChannel",
        ["ECC_" + label.upper(), label.upper()],
        _COLLISION_CHANNEL_VALUES[key],
    )
    if channel is None:
        raise ValueError(
            "unreal.CollisionChannel is unavailable in this build; cannot address channel {0}.".format(
                label
            )
        )
    return key, label, channel


def _resolve_collision_response(response_name):
    key = str(response_name or "").strip().lower()
    if key not in _COLLISION_RESPONSE_VALUES:
        raise ValueError(
            "Unknown collision response '{0}'. Use one of: ignore, overlap, block.".format(
                response_name
            )
        )

    label = key.upper()
    response = _resolve_enum(
        "CollisionResponse",
        ["ECR_" + label, label],
        _COLLISION_RESPONSE_VALUES[key],
    )
    if response is None:
        raise ValueError(
            "unreal.CollisionResponse is unavailable in this build; cannot set response {0}.".format(
                key
            )
        )
    return key, response


# ---------------------------------------------------------------------------
# PIE discovery
# ---------------------------------------------------------------------------


def _get_pie_worlds():
    if not hasattr(unreal.EditorLevelLibrary, "get_pie_worlds"):
        return []

    try:
        return list(unreal.EditorLevelLibrary.get_pie_worlds(False) or [])
    except TypeError:
        try:
            return list(unreal.EditorLevelLibrary.get_pie_worlds() or [])
        except Exception:
            return []
    except Exception:
        return []


def _get_game_world():
    if hasattr(unreal.EditorLevelLibrary, "get_game_world"):
        try:
            world = unreal.EditorLevelLibrary.get_game_world()
            if world:
                return world
        except Exception:
            pass

    for world in _get_pie_worlds():
        if world:
            return world
    return None


def _pie_worlds_ordered():
    worlds = []
    game_world = _get_game_world()
    if game_world:
        worlds.append(game_world)
    for world in _get_pie_worlds():
        if not world:
            continue
        if any(world == existing for existing in worlds):
            continue
        worlds.append(world)
    return worlds


def _world_time_seconds(world):
    if not world:
        return None
    for method_name in ("get_time_seconds", "get_real_time_seconds"):
        method = getattr(unreal.GameplayStatics, method_name, None)
        if not callable(method):
            continue
        try:
            return float(method(world))
        except Exception:
            continue
    return None


def _actors_in_world(world):
    if not world:
        return []
    try:
        actors = unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor)
    except Exception:
        return []
    return list(actors or [])


def _actor_names(actor):
    names = []
    for accessor in ("get_name", "get_actor_label"):
        try:
            value = getattr(actor, accessor)()
        except Exception:
            continue
        if value:
            names.append(str(value))
    return names


def _find_pie_actor(actor_name):
    wanted = str(actor_name or "").strip()
    if not wanted:
        return None, []

    available = []
    exact_match = None
    partial_match = None
    wanted_lower = wanted.lower()

    for world in _pie_worlds_ordered():
        for actor in _actors_in_world(world):
            names = _actor_names(actor)
            for candidate in names:
                if candidate not in available:
                    available.append(candidate)
            lowered = [candidate.lower() for candidate in names]
            if exact_match is None and wanted_lower in lowered:
                exact_match = actor
            elif partial_match is None and any(wanted_lower in name for name in lowered):
                partial_match = actor

    if exact_match is not None:
        return exact_match, available
    if partial_match is not None:
        return partial_match, available
    return None, available


def _pie_world_or_failure(action_name):
    if not is_editor_in_play():
        return None, _failure(
            "{0} requires Play-In-Editor. Start PIE and retry.".format(action_name),
            requires_pie=True,
            reason="pie_not_running",
        )

    world = _get_game_world()
    if not world:
        return None, _failure(
            "{0} could not resolve the PIE game world even though PIE is active. "
            "Wait for the session to finish loading and retry.".format(action_name),
            requires_pie=True,
            reason="pie_world_unavailable",
        )

    return world, None


def _pie_actor_or_failure(args, action_name):
    world, failure = _pie_world_or_failure(action_name)
    if failure:
        return None, failure

    target_name = _first_string(args, ("target", "actor_name"))
    if not target_name:
        return None, _failure(
            "{0} requires 'target' (the name or label of an actor in the running PIE session).".format(
                action_name
            ),
            reason="missing_target",
        )

    actor, available = _find_pie_actor(target_name)
    if not actor:
        return None, _failure(
            "No PIE actor named '{0}' was found.".format(target_name),
            reason="pie_actor_not_found",
            target=target_name,
            available_actors=available[:25],
        )

    return actor, None


# ---------------------------------------------------------------------------
# component helpers
# ---------------------------------------------------------------------------


def _actor_label(actor):
    try:
        return str(actor.get_actor_label())
    except Exception:
        return None


def _actor_summary(actor):
    return {
        "name": get_object_name(actor),
        "label": _actor_label(actor),
        "class": get_object_class_name(actor),
    }


def _actor_primitive_components(actor):
    components = []
    try:
        components = list(actor.get_components_by_class(unreal.PrimitiveComponent) or [])
    except Exception:
        components = []

    if components:
        return components

    try:
        for component in list(actor.get_components_by_class(unreal.ActorComponent) or []):
            if object_is_instance_of(component, "PrimitiveComponent"):
                components.append(component)
    except Exception:
        pass

    return components


def _component_names(components):
    names = []
    for component in components:
        name = get_object_name(component)
        if name and name not in names:
            names.append(name)
    return names


def _component_matches(component, component_name):
    wanted = str(component_name or "").strip().lower()
    if not wanted:
        return False

    names = [get_object_name(component)]
    try:
        names.append(str(component.get_name()))
    except Exception:
        pass

    for name in names:
        if not name:
            continue
        lowered = name.lower()
        if lowered == wanted:
            return True
        if lowered.endswith("_gen_variable") and lowered[: -len("_gen_variable")] == wanted:
            return True
    return False


def _root_component(actor):
    root = get_editor_property_value(actor, "root_component", None)
    if root:
        return root
    try:
        root = actor.get_root_component()
        if root:
            return root
    except Exception:
        pass
    return None


def _select_primitive_component(components, component_name, owner_label, root=None):
    if not components:
        raise ValueError(
            "{0} has no primitive component that a physics action can target.".format(
                owner_label
            )
        )

    if component_name:
        matches = [
            component
            for component in components
            if _component_matches(component, component_name)
        ]
        if not matches:
            raise ValueError(
                "Component '{0}' was not found on {1}. Available primitive components: {2}".format(
                    component_name, owner_label, ", ".join(_component_names(components)) or "(none)"
                )
            )
        return matches[0]

    if root is not None:
        for component in components:
            if component == root:
                return component

    if len(components) == 1:
        return components[0]

    raise ValueError(
        "{0} has multiple primitive components; pass component_name. Available: {1}".format(
            owner_label, ", ".join(_component_names(components))
        )
    )


def _simulating_physics(component):
    try:
        return bool(component.is_simulating_physics())
    except Exception:
        pass
    value = get_editor_property_value(component, "simulate_physics", None)
    if value is None:
        return None
    return bool(value)


def _component_mass(component):
    try:
        return _round(component.get_mass(), 3)
    except Exception:
        pass
    value = get_editor_property_value(component, "mass", None)
    return _round(value, 3)


def _linear_velocity(component):
    try:
        velocity = component.get_physics_linear_velocity()
    except Exception:
        return None
    return _round_vector(velocity)


def _component_summary(component):
    return {
        "name": get_object_name(component),
        "class": get_object_class_name(component),
        "simulating_physics": _simulating_physics(component),
        "mass_kg": _component_mass(component),
    }


# ---------------------------------------------------------------------------
# PIE force / impulse / torque
# ---------------------------------------------------------------------------


def _apply_pie_vector(args, action_name, vector_key, method_names, change_key, change_default):
    actor, failure = _pie_actor_or_failure(args, action_name)
    if failure:
        return failure

    vector = _vector_arg(_first_value(args, (vector_key,)), vector_key)
    if abs(vector.x) + abs(vector.y) + abs(vector.z) <= 0.0:
        return _failure(
            "{0} requires a non-zero '{1}' vector.".format(action_name, vector_key),
            reason="zero_vector",
        )

    component_name = _first_string(args, ("component_name",))
    components = _actor_primitive_components(actor)
    component = _select_primitive_component(
        components,
        component_name,
        "PIE actor '{0}'".format(get_object_name(actor)),
        root=_root_component(actor),
    )

    simulating = _simulating_physics(component)
    if simulating is False:
        return _failure(
            "Component '{0}' on PIE actor '{1}' is not simulating physics, so the {2} would be discarded.".format(
                get_object_name(component), get_object_name(actor), vector_key
            ),
            reason="physics_not_simulating",
            component=_component_summary(component),
            actor=_actor_summary(actor),
            hint="Enable simulation first (manage_physics.set_physics_properties with simulate_physics, or set simulate physics on the spawned actor).",
        )

    bone_name = _first_string(args, ("bone_name",))
    accelerate = _optional_bool(args, change_key, change_default)

    bone_reference = _fname(bone_name)

    method_name = None
    errors = []
    for candidate_method in method_names:
        method = getattr(component, candidate_method, None)
        if not callable(method):
            errors.append("{0}: not available".format(candidate_method))
            continue

        attempts = [
            (vector, bone_reference, accelerate),
            (vector, bone_name or "None", accelerate),
        ]
        if not accelerate:
            attempts.append((vector,))

        for attempt in attempts:
            try:
                method(*attempt)
                method_name = candidate_method
                break
            except TypeError as exc:
                errors.append("{0}{1}: {2}".format(candidate_method, len(attempt), exc))
                continue
            except Exception as exc:
                errors.append("{0}: {1}".format(candidate_method, exc))
                break

        if method_name:
            break

    if not method_name:
        return _failure(
            "Could not apply {0} to component '{1}'.".format(vector_key, get_object_name(component)),
            reason="force_call_failed",
            errors=errors,
            component=_component_summary(component),
        )

    result = {
        "success": True,
        "operation": action_name,
        "world": "pie",
        "actor": _actor_summary(actor),
        "component": _component_summary(component),
        "applied": {
            vector_key: _round_vector(vector),
            "bone_name": bone_name,
            change_key: accelerate,
            "method": method_name,
        },
        "warnings": [],
    }

    if action_name == "add_impulse":
        velocity_after = _linear_velocity(component)
        result["linear_velocity_after"] = velocity_after
        if accelerate and velocity_after is not None:
            magnitude = abs(velocity_after[0]) + abs(velocity_after[1]) + abs(velocity_after[2])
            if magnitude <= 0.0:
                result["warnings"].append(
                    "Velocity is still zero right after the impulse; the body may be asleep or constrained."
                )

    if errors:
        result["call_notes"] = errors

    return result


def add_force(args):
    return _apply_pie_vector(
        args,
        "add_force",
        "force",
        ("add_force",),
        "accel_change",
        False,
    )


def add_impulse(args):
    return _apply_pie_vector(
        args,
        "add_impulse",
        "impulse",
        ("add_impulse",),
        "vel_change",
        False,
    )


def add_torque(args):
    return _apply_pie_vector(
        args,
        "add_torque",
        "torque",
        ("add_torque_in_radians", "add_torque"),
        "accel_change",
        False,
    )


# ---------------------------------------------------------------------------
# collision helpers
# ---------------------------------------------------------------------------


def _read_collision_profile(component):
    value = get_editor_property_value(component, "collision_profile_name", None)
    if value is None:
        getter = getattr(component, "get_collision_profile_name", None)
        if callable(getter):
            try:
                value = getter()
            except Exception:
                value = None
    if value is None:
        return None
    text = str(value)
    return text or None


def _apply_collision_profile_name(component, profile_name):
    setter = getattr(component, "set_collision_profile_name", None)
    errors = []
    if callable(setter):
        for candidate_arg in (_fname(profile_name), str(profile_name)):
            try:
                setter(candidate_arg)
                return {"method": "set_collision_profile_name", "errors": errors}
            except Exception as exc:
                errors.append(str(exc))

    if set_object_property(component, "collision_profile_name", _fname(profile_name)):
        return {"method": "set_editor_property", "errors": errors}

    raise ValueError(
        "Could not set collision profile '{0}' on '{1}': {2}".format(
            profile_name, get_object_name(component), "; ".join(errors) or "no writable property"
        )
    )


def _profiles_match(requested, actual):
    if actual is None:
        return False
    return str(requested).strip().lower() == str(actual).strip().lower()


def _blueprint_primitive_component(blueprint, component_name):
    blueprint_label = "Blueprint '{0}'".format(get_object_name(blueprint))

    if component_name:
        node, template = get_component_template(blueprint, component_name)
        if template is None or not object_is_instance_of(template, "PrimitiveComponent"):
            raise ValueError(
                "Component '{0}' on {1} is not a primitive component.".format(
                    component_name, blueprint_label
                )
            )
        return node is not None, template

    candidates = []
    for candidate_name in list_blueprint_component_names(blueprint):
        try:
            node, template = get_component_template(blueprint, candidate_name)
        except Exception:
            continue
        if template is None or not object_is_instance_of(template, "PrimitiveComponent"):
            continue
        candidates.append((node is not None, template))

    if not candidates:
        raise ValueError(
            "{0} has no primitive component. Available components: {1}".format(
                blueprint_label, ", ".join(list_blueprint_component_names(blueprint)) or "(none)"
            )
        )

    if len(candidates) == 1:
        return candidates[0]

    raise ValueError(
        "{0} has multiple primitive components; pass component_name. Available: {1}".format(
            blueprint_label,
            ", ".join(get_object_name(template) for _, template in candidates),
        )
    )


def _resolve_component_target(args, action_name):
    blueprint_identifier = _first_string(args, ("blueprint_name", "asset_path", "name"))
    actor_name = _first_string(args, ("target", "actor_name"))

    if blueprint_identifier and actor_name:
        raise ValueError(
            "Pass either a Blueprint (blueprint_name/asset_path/name) or a placed actor (target/actor_name), not both."
        )

    if not blueprint_identifier and not actor_name:
        raise ValueError(
            "{0} needs a target: blueprint_name/asset_path/name or target/actor_name.".format(
                action_name
            )
        )

    component_name = _first_string(args, ("component_name",))

    if blueprint_identifier:
        blueprint = load_blueprint_asset(blueprint_identifier)
        if not blueprint:
            raise ValueError("Blueprint not found: {0}".format(blueprint_identifier))
        requires_compile, component = _blueprint_primitive_component(blueprint, component_name)
        return {
            "kind": "blueprint",
            "owner": blueprint,
            "component": component,
            "component_name": get_object_name(component),
            "requires_compile": requires_compile,
            "report": {
                "kind": "blueprint",
                "name": get_object_name(blueprint),
                "path": get_asset_package_name(blueprint),
            },
        }

    actor = find_actor_by_name(actor_name)
    if not actor:
        raise ValueError(
            "Actor not found in the editor level: {0}".format(actor_name)
        )

    component = _select_primitive_component(
        _actor_primitive_components(actor),
        component_name,
        "Actor '{0}'".format(get_object_name(actor)),
    )
    return {
        "kind": "actor",
        "owner": actor,
        "component": component,
        "component_name": get_object_name(component),
        "requires_compile": False,
        "report": {
            "kind": "actor",
            "name": get_object_name(actor),
            "label": _actor_label(actor),
            "class": get_object_class_name(actor),
            "world": "editor",
        },
    }


def _persist_change(target, save, requires_compile):
    persistence = {
        "compiled": False,
        "compile_required": bool(requires_compile),
        "saved": False,
    }

    if target["kind"] == "blueprint":
        blueprint = target["owner"]
        cdo = get_blueprint_default_object(blueprint)
        if cdo:
            touch_editor_object(cdo)
        touch_editor_object(blueprint)
        try:
            blueprint.post_edit_change()
        except Exception:
            pass
    else:
        touch_editor_object(target["owner"])
        try:
            target["owner"].post_edit_change()
        except Exception:
            pass

    if requires_compile:
        try:
            persistence["compiled"] = bool(try_compile_blueprint(target["owner"]))
        except Exception:
            persistence["compiled"] = False

    if save:
        if target["kind"] == "blueprint":
            try:
                persistence["saved"] = bool(save_loaded_editor_asset(target["owner"]))
            except Exception:
                persistence["saved"] = False
        else:
            persistence["saved"] = False
            persistence["level_saved"] = False

    return persistence


def _verify_target_component(target):
    """Re-resolve the component after a compile so verification reads the CDO."""
    if target["kind"] != "blueprint":
        return target["component"]

    blueprint = get_blueprint_default_object(target["owner"])
    if blueprint:
        try:
            for component in list(blueprint.get_components_by_class(unreal.ActorComponent) or []):
                if component == target["component"]:
                    return component
                if _component_matches(component, target["component_name"]):
                    return component
        except Exception:
            pass

    return target["component"]


def set_collision_profile(args):
    action_name = "set_collision_profile"
    profile_name = _required_string(args, "profile_name")
    save = _optional_bool(args, "save", True)

    blueprint_identifier = _first_string(args, ("blueprint_name", "asset_path", "name"))
    if blueprint_identifier:
        plugin_result = _run_graph_operation(
            "set_collision_profile",
            {
                "blueprint_name": blueprint_identifier,
                "component_name": _first_string(args, ("component_name",)),
                "profile_name": profile_name,
                "save": save,
            },
        )
        if plugin_result is None:
            raise ValueError(
                "set_collision_profile on Blueprint defaults needs the UEVGraphAuthoring plugin, which is not loaded."
            )
        plugin_result.setdefault("operation", action_name)
        collision = plugin_result.get("collision_profile") or {}
        if plugin_result.get("success") and not collision.get("verified"):
            plugin_result["success"] = False
            plugin_result["reason"] = "profile_not_applied"
            plugin_result["message"] = (
                "The engine kept collision profile '{0}' instead of '{1}'.".format(
                    collision.get("applied"), profile_name
                )
            )
        return plugin_result

    target = _resolve_component_target(args, action_name)
    component = target["component"]

    previous_profile = _read_collision_profile(component)
    applied = _apply_collision_profile_name(component, profile_name)

    persistence = _persist_change(target, save, target["requires_compile"])
    component_after = _verify_target_component(target)
    applied_profile = _read_collision_profile(component_after)

    result = {
        "success": True,
        "operation": action_name,
        "target": target["report"],
        "component": _component_summary(component_after),
        "collision_profile": {
            "requested": profile_name,
            "previous": previous_profile,
            "applied": applied_profile,
            "verified": _profiles_match(profile_name, applied_profile),
            "method": applied["method"],
        },
        "persistence": persistence,
        "warnings": [],
    }

    if not result["collision_profile"]["verified"]:
        result["success"] = False
        result["reason"] = "profile_not_applied"
        result["message"] = (
            "The engine kept collision profile '{0}' instead of '{1}'. Check that the profile name exists "
            "in Project Settings > Collision.".format(applied_profile, profile_name)
        )

    if target["kind"] == "actor" and save:
        result["warnings"].append(
            "Placed-actor edits are not written to disk by this action; save the level to persist them."
        )

    if not persistence["compile_required"] and target["kind"] == "blueprint":
        result["notes"] = [
            "Edited the CDO subobject directly, so no Blueprint compile was triggered."
        ]
    elif persistence["compile_required"]:
        result["notes"] = [
            "Edited a construction-script template, so one Blueprint compile was required."
        ]

    return result


def _read_collision_response(component, channel_ref):
    getter = getattr(component, "get_collision_response_to_channel", None)
    if not callable(getter):
        return None
    try:
        return _enum_ordinal(getter(channel_ref))
    except Exception:
        return None


def set_collision_response(args):
    action_name = "set_collision_response"
    channel_key = _collision_channel_key(_required_string(args, "channel"))
    channel_label = _COLLISION_CHANNEL_LABELS[channel_key]
    response_key = _collision_response_key(_required_string(args, "response"))
    save = _optional_bool(args, "save", True)

    blueprint_identifier = _first_string(args, ("blueprint_name", "asset_path", "name"))
    if blueprint_identifier:
        plugin_result = _run_graph_operation(
            "set_collision_response",
            {
                "blueprint_name": blueprint_identifier,
                "component_name": _first_string(args, ("component_name",)),
                "channel": _COLLISION_CHANNEL_VALUES[channel_key],
                "response": _COLLISION_RESPONSE_VALUES[response_key],
                "save": save,
            },
        )
        if plugin_result is None:
            raise ValueError(
                "set_collision_response on Blueprint defaults needs the UEVGraphAuthoring plugin, which is not loaded."
            )
        plugin_result.setdefault("operation", action_name)
        collision = plugin_result.get("collision_response") or {}
        collision["channel"] = channel_label
        collision["response"] = response_key
        plugin_result["collision_response"] = collision
        if plugin_result.get("success") and not collision.get("verified"):
            plugin_result["success"] = False
            plugin_result["reason"] = "response_not_verified"
            plugin_result["message"] = (
                "The collision response could not be read back as requested; the engine may have kept the old value."
            )
        return plugin_result

    channel = _resolve_enum(
        "CollisionChannel",
        ["ECC_" + channel_label.upper(), channel_label.upper()],
        _COLLISION_CHANNEL_VALUES[channel_key],
    )
    if channel is None:
        raise ValueError(
            "unreal.CollisionChannel is unavailable in this build; cannot set collision response on a placed actor. Edit the Blueprint default instead."
        )
    response = _resolve_enum(
        "CollisionResponse",
        ["ECR_" + response_key.upper(), response_key.upper()],
        _COLLISION_RESPONSE_VALUES[response_key],
    )
    if response is None:
        raise ValueError(
            "unreal.CollisionResponse is unavailable in this build; cannot set collision response on a placed actor."
        )

    target = _resolve_component_target(args, action_name)
    component = target["component"]

    previous_response = _read_collision_response(component, channel)

    setter = getattr(component, "set_collision_response_to_channel", None)
    if not callable(setter):
        raise ValueError(
            "Component '{0}' does not expose set_collision_response_to_channel.".format(
                get_object_name(component)
            )
        )

    profile_switch = None
    try:
        profile_switch = _apply_collision_profile_name(component, "Custom")
    except ValueError:
        profile_switch = None

    errors = []
    applied = False
    for attempt in (
        (channel, response),
        (_COLLISION_CHANNEL_VALUES[channel_key], _COLLISION_RESPONSE_VALUES[response_key]),
    ):
        try:
            setter(attempt[0], attempt[1])
            applied = True
            break
        except Exception as exc:
            errors.append(str(exc))

    if not applied:
        return _failure(
            "Could not set the collision response for channel {0} on '{1}'.".format(
                channel_label, get_object_name(component)
            ),
            reason="collision_response_failed",
            errors=errors,
        )

    persistence = _persist_change(target, save, target["requires_compile"])
    component_after = _verify_target_component(target)
    applied_response_index = _read_collision_response(component_after, channel)

    result = {
        "success": True,
        "operation": action_name,
        "target": target["report"],
        "component": _component_summary(component_after),
        "collision_response": {
            "channel": channel_label,
            "channel_index": _COLLISION_CHANNEL_VALUES[channel_key],
            "response": response_key,
            "response_index": _COLLISION_RESPONSE_VALUES[response_key],
            "previous_response_index": previous_response,
            "applied_response_index": applied_response_index,
            "verified": applied_response_index == _COLLISION_RESPONSE_VALUES[response_key],
        },
        "collision_profile": {
            "name": _read_collision_profile(component_after),
            "switched_to_custom": profile_switch is not None,
        },
        "persistence": persistence,
        "warnings": [],
    }

    if not result["collision_response"]["verified"]:
        result["success"] = False
        result["reason"] = "response_not_verified"
        result["message"] = (
            "The collision response could not be read back as requested; the engine may have kept the old value."
        )

    if profile_switch is None:
        result["warnings"].append(
            "Could not switch the component to the Custom collision profile; the channel response may not take effect."
        )

    if target["kind"] == "actor" and save:
        result["warnings"].append(
            "Placed-actor edits are not written to disk by this action; save the level to persist them."
        )

    return result


# ---------------------------------------------------------------------------
# character movement
# ---------------------------------------------------------------------------


def _blueprint_generated_class(blueprint):
    generated = get_blueprint_default_object(blueprint)
    if generated:
        return generated
    try:
        blueprint_class = unreal.EditorAssetLibrary.load_blueprint_class(
            get_asset_package_name(blueprint)
        )
    except Exception:
        blueprint_class = None
    if blueprint_class:
        try:
            return unreal.get_default_object(blueprint_class)
        except Exception:
            return None
    return None


def _blueprint_character_movement(blueprint):
    cdo = _blueprint_generated_class(blueprint)
    if cdo:
        try:
            components = list(cdo.get_components_by_class(unreal.CharacterMovementComponent) or [])
        except Exception:
            components = []
        if components:
            return components[0]

    for _, component in get_blueprint_component_candidates(blueprint):
        if object_is_instance_of(component, "CharacterMovementComponent"):
            return component

    raise ValueError(
        "Blueprint '{0}' has no CharacterMovementComponent. Only Character or Pawn Blueprints carry one.".format(
            get_object_name(blueprint)
        )
    )


def _actor_character_movement(actor):
    try:
        components = list(actor.get_components_by_class(unreal.CharacterMovementComponent) or [])
    except Exception:
        components = []

    if not components:
        for component in _actor_components(actor):
            if object_is_instance_of(component, "CharacterMovementComponent"):
                components.append(component)

    if not components:
        raise ValueError(
            "Actor '{0}' has no CharacterMovementComponent.".format(get_object_name(actor))
        )
    return components[0]


def _actor_components(actor):
    try:
        return list(actor.get_components_by_class(unreal.ActorComponent) or [])
    except Exception:
        return []


def _movement_report(component):
    report = {}
    for arg_key, property_name, _, _ in _MOVEMENT_PROPERTIES:
        report[arg_key] = _round(get_editor_property_value(component, property_name, None), 4)
    return report


def set_character_movement(args):
    action_name = "set_character_movement"
    save = _optional_bool(args, "save", True)

    requested = {}
    for arg_key, property_name, minimum, maximum in _MOVEMENT_PROPERTIES:
        value = _optional_float(args, arg_key)
        if value is None:
            continue
        if minimum is not None and value < minimum:
            raise ValueError(
                "Argument '{0}' must be >= {1} (received {2}).".format(arg_key, minimum, value)
            )
        if maximum is not None and value > maximum:
            raise ValueError(
                "Argument '{0}' must be <= {1} (received {2}).".format(arg_key, maximum, value)
            )
        requested[arg_key] = (value, property_name)

    if not requested:
        raise ValueError(
            "set_character_movement needs at least one movement property: {0}.".format(
                ", ".join(entry[0] for entry in _MOVEMENT_PROPERTIES)
            )
        )

    blueprint_identifier = _first_string(args, ("blueprint_name", "asset_path", "name"))
    actor_name = _first_string(args, ("target", "actor_name"))
    if blueprint_identifier and actor_name:
        raise ValueError(
            "Pass either a Blueprint (blueprint_name/asset_path/name) or a placed actor (target/actor_name), not both."
        )
    if not blueprint_identifier and not actor_name:
        raise ValueError(
            "set_character_movement needs a target: blueprint_name/asset_path/name or target/actor_name."
        )

    if blueprint_identifier:
        blueprint = load_blueprint_asset(blueprint_identifier)
        if not blueprint:
            raise ValueError("Blueprint not found: {0}".format(blueprint_identifier))
        component = _blueprint_character_movement(blueprint)
        target = {
            "kind": "blueprint",
            "owner": blueprint,
            "requires_compile": False,
            "report": {
                "kind": "blueprint",
                "name": get_object_name(blueprint),
                "path": get_asset_package_name(blueprint),
            },
        }
    else:
        actor = find_actor_by_name(actor_name)
        if not actor:
            raise ValueError("Actor not found in the editor level: {0}".format(actor_name))
        component = _actor_character_movement(actor)
        target = {
            "kind": "actor",
            "owner": actor,
            "requires_compile": False,
            "report": {
                "kind": "actor",
                "name": get_object_name(actor),
                "label": _actor_label(actor),
                "class": get_object_class_name(actor),
                "world": "editor",
            },
        }

    previous = _movement_report(component)

    applied = {}
    failed = {}
    for arg_key, (value, property_name) in requested.items():
        if set_object_property(component, property_name, value):
            applied[arg_key] = value
        else:
            failed[arg_key] = property_name

    if not applied:
        return _failure(
            "None of the requested CharacterMovement properties are writable on '{0}'.".format(
                get_object_name(component)
            ),
            reason="movement_properties_not_writable",
            failed_properties=failed,
        )

    persistence = _persist_change(target, save, False)

    verification = {}
    mismatches = {}
    for arg_key, value in applied.items():
        property_name = requested[arg_key][1]
        actual = _round(get_editor_property_value(component, property_name, None), 4)
        verification[arg_key] = actual
        if actual is None or abs(float(actual) - float(value)) > 0.01:
            mismatches[arg_key] = actual

    result = {
        "success": not mismatches,
        "operation": action_name,
        "target": target["report"],
        "component": {
            "name": get_object_name(component),
            "class": get_object_class_name(component),
        },
        "movement": {
            "previous": previous,
            "requested": {key: value for key, (value, _) in requested.items()},
            "applied": applied,
            "verified": verification,
        },
        "persistence": persistence,
        "notes": [
            "Edited the CharacterMovementComponent subobject directly; no Blueprint compile was triggered.",
        ],
        "warnings": [],
    }

    if failed:
        result["failed_properties"] = failed
    if mismatches:
        result["reason"] = "movement_values_not_retained"
        result["message"] = (
            "Some CharacterMovement properties did not keep the requested values after writing: {0}".format(
                ", ".join(sorted(mismatches))
            )
        )

    if target["kind"] == "actor" and save:
        result["warnings"].append(
            "Placed-actor edits are not written to disk by this action; save the level to persist them."
        )

    return result


# ---------------------------------------------------------------------------
# PIE drop assertion
# ---------------------------------------------------------------------------


def _resolve_actor_class(identifier):
    text = str(identifier or "").strip()
    if not text:
        raise ValueError("actor_class must name a class or Blueprint asset path.")

    actor_class = None
    try:
        actor_class = resolve_class_reference(text)
    except Exception:
        actor_class = None

    if actor_class:
        return actor_class

    blueprint = None
    try:
        blueprint = load_blueprint_asset(text)
    except Exception:
        blueprint = None

    if blueprint:
        generated_class = get_blueprint_generated_class(blueprint)
        if generated_class:
            return generated_class

    try:
        actor_class = unreal.EditorAssetLibrary.load_blueprint_class(text)
        if actor_class:
            return actor_class
    except Exception:
        pass

    raise ValueError(
        "Could not resolve '{0}' to an actor class or Blueprint. Pass a Blueprint asset path or a native class name.".format(
            text
        )
    )


def _set_actor_label(actor, label):
    if not label:
        return False
    try:
        actor.set_actor_label(str(label))
        return True
    except Exception:
        return set_object_property(actor, "actor_label", str(label))


def _spawn_pie_actor(world, actor_class, location, label=None):
    rotation = unreal.Rotator(0.0, 0.0, 0.0)
    transform = unreal.Transform(
        location=location,
        rotation=rotation,
        scale=unreal.Vector(1.0, 1.0, 1.0),
    )
    errors = []

    gameplay_statics = getattr(unreal, "GameplayStatics", None)
    spawn_override = _resolve_enum(
        "SpawnCollisionHandlingOverride", ["ALWAYS_SPAWN", "ECS_ALWAYS_SPAWN"], None
    )

    if gameplay_statics is not None:
        begin = getattr(gameplay_statics, "begin_deferred_actor_spawn_from_class", None)
        finish = getattr(gameplay_statics, "finish_spawning_actor", None)
        if callable(begin) and callable(finish):
            begin_attempts = []
            if spawn_override is not None:
                begin_attempts.append((world, actor_class, transform, spawn_override))
                begin_attempts.append((world, actor_class, transform))
            else:
                begin_attempts.append((world, actor_class, transform))

            for begin_args in begin_attempts:
                try:
                    deferred = begin(*begin_args)
                except Exception as exc:
                    errors.append("begin_deferred_actor_spawn_from_class: {0}".format(exc))
                    continue

                if not deferred:
                    errors.append("begin_deferred_actor_spawn_from_class returned None")
                    continue

                for finish_args in ((deferred, transform), (deferred, transform, True)):
                    try:
                        actor = finish(*finish_args)
                    except Exception as exc:
                        errors.append("finish_spawning_actor: {0}".format(exc))
                        continue
                    if actor:
                        _set_actor_label(actor, label)
                        return actor, "gameplay_statics_deferred", errors

    editor_library = getattr(unreal, "EditorLevelLibrary", None)
    spawn = getattr(editor_library, "spawn_actor_from_class", None)
    if callable(spawn):
        for spawn_args in ((actor_class, location, rotation), (actor_class, location)):
            try:
                actor = spawn(*spawn_args)
            except Exception as exc:
                errors.append("EditorLevelLibrary.spawn_actor_from_class: {0}".format(exc))
                continue

            if not actor:
                continue

            actor_world = None
            try:
                actor_world = actor.get_world()
            except Exception:
                actor_world = None

            if actor_world is not None and world is not None and actor_world != world:
                errors.append(
                    "EditorLevelLibrary.spawn_actor_from_class spawned into the editor world, not PIE"
                )
                try:
                    destroy_actor(actor)
                except Exception:
                    pass
                continue

            _set_actor_label(actor, label)
            return actor, "editor_level_library", errors

    return None, None, errors


def _hit_result(result):
    if result is None:
        return None
    if isinstance(result, (list, tuple)):
        for item in reversed(result):
            if item is None:
                continue
            for attribute in ("blocking_hit", "b_blocking_hit", "location", "impact_point"):
                if hasattr(item, attribute):
                    return item
        return None
    return result


def _hit_blocks(hit):
    for attribute in ("blocking_hit", "b_blocking_hit"):
        try:
            return bool(getattr(hit, attribute))
        except Exception:
            continue
    return True


def _hit_z(hit):
    for attribute in ("location", "impact_point"):
        try:
            value = getattr(hit, attribute)
        except Exception:
            continue
        z_value = getattr(value, "z", None)
        if z_value is None and isinstance(value, (list, tuple)) and len(value) >= 3:
            z_value = value[2]
        if z_value is not None:
            return float(z_value)
    return None


def _trace_ground(world, x, y, ignore_actor=None):
    channel = _resolve_enum("CollisionChannel", ["ECC_VISIBILITY", "VISIBILITY"], 3)
    if channel is None:
        return None

    debug_none = None
    debug_trace_class = getattr(unreal, "DrawDebugTrace", None)
    if debug_trace_class is not None:
        debug_none = getattr(debug_trace_class, "NONE", None)

    ignore_actors = []
    if ignore_actor is not None:
        ignore_actors.append(ignore_actor)

    start = unreal.Vector(x, y, _GROUND_TRACE_START_Z)
    end = unreal.Vector(x, y, _GROUND_TRACE_END_Z)

    functions = []
    for holder_name in ("SystemLibrary", "KismetSystemLibrary"):
        holder = getattr(unreal, holder_name, None)
        if holder is None:
            continue
        function = getattr(holder, "line_trace_single_by_channel", None)
        if callable(function) and function not in functions:
            functions.append(function)

    for function in functions:
        attempts = []
        if debug_none is not None:
            attempts.append((world, start, end, channel, True, ignore_actors, debug_none))
            attempts.append((world, start, end, channel, True, ignore_actors))
        attempts.append((world, start, end, channel, True))
        attempts.append((world, start, end, channel))

        for attempt in attempts:
            try:
                result = function(*attempt)
            except Exception:
                continue
            hit = _hit_result(result)
            if hit is None:
                continue
            if not _hit_blocks(hit):
                return None
            z_value = _hit_z(hit)
            if z_value is not None:
                return z_value

    return None


def _ground_reference(world, x, y, ignore_actor, expected_ground_z):
    if expected_ground_z is not None:
        return float(expected_ground_z), "expected_ground_z", []

    traced = _trace_ground(world, x, y, ignore_actor)
    if traced is not None:
        return traced, "line_trace", []

    return None, None, [
        "Ground Z could not be traced; pass expected_ground_z to assert resting height and fall-through."
    ]


def _run_drop_sampling(world, actor, component, ground_z, wall_budget_seconds, max_frames):
    deadline = time.monotonic() + wall_budget_seconds
    first_world_time = _world_time_seconds(world)
    previous_world_time = first_world_time
    last_world_time = first_world_time

    frames_sampled = 0
    z_samples = []
    start_z = None
    end_z = None
    end_velocity = None
    resting = None
    stop_reason = "frame_budget"
    stalled_samples = 0

    while frames_sampled < max_frames:
        if time.monotonic() >= deadline:
            stop_reason = "wall_clock_budget"
            break

        frames_sampled += 1

        try:
            current_z = float(actor.get_actor_location().z)
        except Exception:
            stop_reason = "actor_unavailable"
            break

        if start_z is None:
            start_z = current_z
        end_z = current_z
        z_samples.append(_round(current_z, 2))

        velocity = _linear_velocity(component)
        if velocity is not None:
            end_velocity = velocity

        world_time = _world_time_seconds(world)
        advanced = None
        if world_time is not None and previous_world_time is not None:
            advanced = world_time - previous_world_time
        if world_time is not None:
            previous_world_time = world_time
            last_world_time = world_time

        if ground_z is not None and abs(end_z - ground_z) <= _DROP_TEST_RESTING_TOLERANCE_CM:
            vertical_speed = abs(velocity[2]) if velocity else 0.0
            if vertical_speed <= _DROP_TEST_RESTING_SPEED_TOLERANCE:
                resting = True
                stop_reason = "at_ground"
                break

        if advanced is not None and advanced <= 0.0:
            stalled_samples += 1
        else:
            stalled_samples = 0

        if stalled_samples >= 3:
            stop_reason = "game_thread_blocked"
            break

        time.sleep(_DROP_TEST_SAMPLE_INTERVAL_SECONDS)

    game_seconds_elapsed = None
    if last_world_time is not None and first_world_time is not None:
        game_seconds_elapsed = _round(last_world_time - first_world_time, 4)

    delta_z = None
    if start_z is not None and end_z is not None:
        delta_z = _round(end_z - start_z, 3)

    return {
        "start_z": _round(start_z, 3),
        "end_z": _round(end_z, 3),
        "delta_z": delta_z,
        "vertical_velocity_z": end_velocity[2] if end_velocity else None,
        "frames_sampled": frames_sampled,
        "game_seconds_elapsed": game_seconds_elapsed,
        "resting": resting,
        "stop_reason": stop_reason,
        "timed_out": stop_reason in ("wall_clock_budget", "frame_budget"),
        "z_samples": z_samples,
    }


def _enable_pie_physics(component, simulate_physics, gravity):
    applied = {}
    for flag_value, method_name, property_name in (
        (simulate_physics, "set_simulate_physics", "simulate_physics"),
        (gravity, "set_enable_gravity", "enable_gravity"),
    ):
        if flag_value is None:
            continue
        method = getattr(component, method_name, None)
        ok = False
        if callable(method):
            try:
                method(bool(flag_value))
                ok = True
            except Exception:
                ok = False
        if not ok:
            ok = set_object_property(component, property_name, bool(flag_value))
        applied[property_name] = ok
    return applied


def pie_drop_test(args):
    action_name = "pie_drop_test"
    world, failure = _pie_world_or_failure(action_name)
    if failure:
        return failure

    target_name = _first_string(args, ("target", "actor_name"))
    class_identifier = _first_string(args, ("actor_class", "class_name"))

    if target_name and class_identifier:
        return _failure(
            "Pass either actor_class (to spawn a new actor) or target (to reuse an existing PIE actor), not both.",
            reason="ambiguous_target",
        )
    if not target_name and not class_identifier:
        return _failure(
            "pie_drop_test needs actor_class or target.",
            reason="missing_target",
        )

    height = _optional_float(args, "height")
    if height is None:
        height = 200.0
    if height <= 0.0:
        raise ValueError(
            "Argument 'height' must be greater than zero (received {0}).".format(height)
        )

    settle_seconds = _optional_float(args, "settle_seconds")
    if settle_seconds is None:
        settle_seconds = _DROP_TEST_DEFAULT_WALL_SECONDS
    settle_seconds = max(0.1, min(float(settle_seconds), _DROP_TEST_MAX_WALL_SECONDS))

    frames_arg = args.get("frames")
    if frames_arg is None or frames_arg == "":
        max_frames = _DROP_TEST_DEFAULT_FRAMES
    else:
        try:
            max_frames = int(frames_arg)
        except Exception:
            raise ValueError("Argument 'frames' must be an integer.")
    max_frames = max(1, min(max_frames, _DROP_TEST_MAX_FRAMES))

    expected_ground_z = _optional_float(args, "expected_ground_z")
    simulate_physics = _optional_bool(args, "simulate_physics", True)
    gravity = _optional_bool(args, "gravity", True)
    component_name = _first_string(args, ("component_name",))
    spawn_label = _first_string(args, ("label",))
    warnings = []

    location_arg = _first_value(args, ("location",))
    location = None
    if location_arg is not None:
        location = _vector_arg(location_arg, "location")

    spawn_info = {"performed": False}

    if class_identifier:
        actor_class = _resolve_actor_class(class_identifier)

        x = location.x if location is not None else 0.0
        y = location.y if location is not None else 0.0
        explicit_z = location.z if location is not None and location.z != 0.0 else None

        ground_z, ground_source, ground_warnings = _ground_reference(
            world, x, y, None, expected_ground_z
        )
        warnings.extend(ground_warnings)

        if explicit_z is not None:
            spawn_z = explicit_z
        elif ground_z is not None:
            spawn_z = ground_z + height
        else:
            spawn_z = height
            warnings.append(
                "Ground Z unknown, so the actor was spawned at Z={0}; the drop assertion only checks that it moves.".format(
                    spawn_z
                )
            )

        spawn_location = unreal.Vector(x, y, spawn_z)
        spawn_errors = []
        actor = None
        spawn_method = None

        class_path = ""
        try:
            class_path = actor_class.get_path_name()
        except Exception:
            class_path = ""
        if class_path and hasattr(unreal, "UEVGraphLibrary"):
            native = _run_gameplay_operation(
                "spawn_pie_actor",
                {
                    "class_path": class_path,
                    "location": [spawn_location.x, spawn_location.y, spawn_location.z],
                    "label": spawn_label or "",
                },
            )
            if native and native.get("success"):
                actor, _available = _find_pie_actor(
                    native.get("actor_label") or native.get("actor_name")
                )
                if actor:
                    spawn_method = "native_spawn_pie_actor"
                else:
                    spawn_errors.append(
                        "Native spawn reported success but the actor was not found in the PIE world."
                    )
            elif native:
                spawn_errors.append(str(native.get("message") or native))

        if not actor:
            actor, spawn_method, spawn_errors = _spawn_pie_actor(
                world, actor_class, spawn_location, spawn_label
            )
        if not actor:
            return _failure(
                "Could not spawn '{0}' into the PIE world from Python in this editor build.".format(
                    class_identifier
                ),
                reason="pie_spawn_unsupported",
                spawn_errors=spawn_errors,
                hint="Place the actor manually in the level, start PIE, then rerun pie_drop_test with target=<actor name>.",
            )

        spawn_info = {
            "performed": True,
            "method": spawn_method,
            "class": get_object_class_name(actor),
            "location": _round_vector(spawn_location),
            "requested_height": height,
        }
    else:
        actor, available = _find_pie_actor(target_name)
        if not actor:
            return _failure(
                "No PIE actor named '{0}' was found.".format(target_name),
                reason="pie_actor_not_found",
                target=target_name,
                available_actors=available[:25],
            )
        spawn_info = {
            "performed": False,
            "location": _round_vector(actor.get_actor_location()),
        }

    actor_location = actor.get_actor_location()
    ground_z, ground_source, ground_warnings = _ground_reference(
        world, actor_location.x, actor_location.y, actor, expected_ground_z
    )
    warnings.extend(ground_warnings)

    component = _select_primitive_component(
        _actor_primitive_components(actor),
        component_name,
        "PIE actor '{0}'".format(get_object_name(actor)),
        root=_root_component(actor),
    )

    physics_flags = _enable_pie_physics(component, simulate_physics, gravity)
    if not all(physics_flags.values()):
        warnings.append(
            "Some physics flags could not be confirmed on the component: {0}".format(
                ", ".join(key for key, ok in physics_flags.items() if not ok)
            )
        )

    if bool(args.get("spawn_only")):
        try:
            initial_location = actor.get_actor_location()
            initial_z = _round(initial_location.z, 3)
        except Exception:
            initial_z = None
        return {
            "success": True,
            "operation": "pie_drop_spawn",
            "world": "pie",
            "actor": _actor_summary(actor),
            "component": _component_summary(component),
            "spawn": spawn_info,
            "ground_z": _round(ground_z, 3),
            "ground_source": ground_source,
            "physics_flags": physics_flags,
            "initial_z": initial_z,
            "sampling": {
                "performed": False,
                "reason": "server_polled_by_caller",
            },
            "warnings": warnings,
        }

    sampling = _run_drop_sampling(
        world, actor, component, ground_z, settle_seconds, max_frames
    )

    fell_through = None
    if ground_z is not None and sampling["end_z"] is not None:
        fell_through = bool(sampling["end_z"] < ground_z - _DROP_TEST_FELL_THROUGH_MARGIN_CM)

    result = {
        "success": True,
        "operation": action_name,
        "world": "pie",
        "actor": _actor_summary(actor),
        "component": _component_summary(component),
        "spawn": spawn_info,
        "ground_z": _round(ground_z, 3),
        "ground_source": ground_source,
        "fell_through": fell_through,
        "physics_flags": physics_flags,
        "sampling": sampling,
        "warnings": warnings,
    }

    if ground_z is None:
        result["success"] = False
        result["reason"] = "ground_unknown"
        result["message"] = (
            "The drop ran but no ground reference was available, so resting height and fall-through could not be asserted."
        )
    elif fell_through:
        result["success"] = False
        result["reason"] = "fell_through"
        result["message"] = (
            "The actor ended {0} cm below the ground reference; collision or the ground mesh did not stop it.".format(
                sampling["delta_z"]
            )
        )
    elif sampling["stop_reason"] == "game_thread_blocked":
        result["success"] = False
        result["reason"] = "simulation_blocked"
        result["message"] = (
            "PIE game time did not advance while this script was sampling, so the drop could not be observed. "
            "Rerun once the editor is not busy; the actor was spawned and left in the PIE world."
        )
    elif sampling["stop_reason"] == "actor_unavailable":
        result["success"] = False
        result["reason"] = "actor_unavailable"
        result["message"] = "The actor disappeared while sampling the drop."
    elif not sampling["resting"]:
        result["success"] = False
        result["reason"] = "not_settled"
        result["message"] = (
            "The actor had not come to rest within {0}s / {1} frames.".format(
                settle_seconds, max_frames
            )
        )

    return result


def pie_component_probe(args):
    actor_name = _first_string(args, ("actor_name", "target"))
    component_name = _first_string(args, ("component_name",))
    actor, available = _find_pie_actor(actor_name)
    if not actor:
        return _failure(
            "No PIE actor named '{0}' was found.".format(actor_name),
            reason="pie_actor_not_found",
            available_actors=available[:25],
        )

    components = _actor_primitive_components(actor)
    component = None
    wanted = str(component_name or "").strip().lower()
    if wanted:
        for candidate in components:
            if get_object_name(candidate).lower() == wanted:
                component = candidate
                break
    elif len(components) == 1:
        component = components[0]
    if component is None:
        return _failure(
            "PIE component '{0}' was not found on '{1}'.".format(component_name, actor_name),
            reason="component_not_found",
            components=[get_object_name(candidate) for candidate in components],
        )

    try:
        location = component.get_world_location()
        location_value = [
            _round(location.x, 3),
            _round(location.y, 3),
            _round(location.z, 3),
        ]
    except Exception as exc:
        return _failure("Could not read the component world location: {0}".format(exc))

    simulating = None
    for method_name in ("is_simulating_physics", "is_any_simulation_running"):
        method = getattr(component, method_name, None)
        if callable(method):
            try:
                simulating = bool(method())
            except Exception:
                simulating = None
            break

    return {
        "success": True,
        "operation": "pie_component_probe",
        "actor": _actor_summary(actor),
        "component": _component_summary(component),
        "location": location_value,
        "simulating_physics": simulating,
    }


OPERATIONS = {
    "pie_component_probe": pie_component_probe,
    "add_force": add_force,
    "add_impulse": add_impulse,
    "add_torque": add_torque,
    "set_collision_profile": set_collision_profile,
    "set_collision_response": set_collision_response,
    "set_character_movement": set_character_movement,
    "pie_drop_test": pie_drop_test,
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
                    "message": "Unknown physics tool operation: {0}".format(operation),
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
