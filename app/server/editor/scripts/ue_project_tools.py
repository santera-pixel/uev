import json
import os
from pathlib import Path


def _parse_key_spec(key_spec):
    tokens = [token.strip() for token in str(key_spec or "").split("+") if token.strip()]
    if not tokens:
        raise ValueError("Key is required")

    modifiers = {"shift": False, "ctrl": False, "alt": False, "cmd": False}
    key_name = tokens[-1]

    for token in tokens[:-1]:
        token_lower = token.lower()
        if token_lower in modifiers:
            modifiers[token_lower] = True
            continue

        if token_lower == "control":
            modifiers["ctrl"] = True
            continue

        if token_lower in ("command", "meta"):
            modifiers["cmd"] = True
            continue

        raise ValueError("Unsupported modifier in key spec: {0}".format(token))

    return key_name, modifiers


def _build_mapping_line(mapping_name, key_name, input_type, scale, modifiers):
    if input_type == "axis":
        return '+AxisMappings=(AxisName="{0}",Scale={1:.6f},Key={2})'.format(
            mapping_name,
            float(scale),
            key_name,
        )

    return (
        '+ActionMappings=(ActionName="{0}",bShift={1},bCtrl={2},bAlt={3},bCmd={4},Key={5})'
    ).format(
        mapping_name,
        "True" if modifiers["shift"] else "False",
        "True" if modifiers["ctrl"] else "False",
        "True" if modifiers["alt"] else "False",
        "True" if modifiers["cmd"] else "False",
        key_name,
    )


def _insert_mapping_line(config_text, mapping_line):
    section_header = "[/Script/Engine.InputSettings]"
    lines = config_text.splitlines()

    if section_header not in lines:
        if config_text and not config_text.endswith("\n"):
            config_text += "\n"
        config_text += "{0}\n{1}\n".format(section_header, mapping_line)
        return config_text

    updated_lines = []
    inside_section = False
    inserted = False

    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == section_header:
            inside_section = True
            updated_lines.append(line)
            continue

        if inside_section and stripped.startswith("[") and stripped.endswith("]"):
            if not inserted:
                updated_lines.append(mapping_line)
                inserted = True
            inside_section = False

        updated_lines.append(line)

    if inside_section and not inserted:
        updated_lines.append(mapping_line)

    return "\n".join(updated_lines) + "\n"


def create_input_mapping(args):
    mapping_name = args.get("mapping_name") or args.get("action_name")
    key_spec = args.get("key")
    input_type = str(args.get("input_type") or "Action").strip().lower()
    scale = float(args.get("scale", 1.0))

    if not mapping_name:
        return {
            "success": False,
            "message": "mapping_name or action_name is required",
        }

    if input_type not in ("action", "axis"):
        return {
            "success": False,
            "message": "input_type must be 'Action' or 'Axis'",
        }

    try:
        key_name, modifiers = _parse_key_spec(key_spec)
    except Exception as exc:
        return {"success": False, "message": str(exc)}

    config_path = (Path(unreal.Paths.project_dir()) / "Config" / "DefaultInput.ini").resolve()
    config_text = ""
    if config_path.exists():
        config_text = config_path.read_text(encoding="utf-8", errors="ignore")

    mapping_line = _build_mapping_line(
        mapping_name,
        key_name,
        input_type,
        scale,
        modifiers,
    )
    if mapping_line in config_text:
        return {
            "success": True,
            "message": "Input mapping already exists",
            "mapping_line": mapping_line,
            "config_path": str(config_path),
        }

    updated_text = _insert_mapping_line(config_text, mapping_line)
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(updated_text, encoding="utf-8")

    input_settings_class = getattr(unreal, "InputSettings", None)
    if input_settings_class and hasattr(input_settings_class, "get_input_settings"):
        try:
            input_settings = input_settings_class.get_input_settings()
            if input_settings:
                for method_name in ("save_key_mappings", "force_rebuild_keymaps"):
                    method = getattr(input_settings, method_name, None)
                    if callable(method):
                        try:
                            method()
                        except Exception:
                            continue
        except Exception:
            pass

    return {
        "success": True,
        "input_type": input_type.title(),
        "mapping_name": mapping_name,
        "key": key_name,
        "modifiers": modifiers,
        "scale": scale,
        "mapping_line": mapping_line,
        "config_path": str(config_path),
    }


def _clamp_int(value, default, minimum=1, maximum=200):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default

    if parsed < minimum:
        return minimum
    if parsed > maximum:
        return maximum
    return parsed


def _asset_tag(asset_data, tag_name):
    try:
        value = get_asset_data_tag_value(asset_data, tag_name)
    except Exception:
        value = None

    if value:
        return str(value)

    getter = getattr(asset_data, "get_tag_value", None)
    if callable(getter):
        try:
            return str(getter(tag_name) or "")
        except Exception:
            return ""

    return ""


def _asset_display_name(asset_data):
    try:
        return get_object_name(asset_data)
    except Exception:
        pass

    try:
        return str(asset_data.asset_name)
    except Exception:
        return ""


def _asset_path_of(asset_data):
    try:
        return get_asset_object_path(asset_data)
    except Exception:
        return ""


def _native_class_name(class_path):
    text = str(class_path or "").strip()
    if not text:
        return ""

    if "." in text:
        text = text.split(".")[-1]
    text = text.split("/")[-1]
    if text.endswith("_C"):
        text = text[:-2]
    return text


def _collect_blueprint_assets(all_assets):
    records = []
    for asset_data in all_assets:
        try:
            if get_asset_class_name(asset_data).lower() != "blueprint":
                continue
        except Exception:
            continue

        asset_path = _asset_path_of(asset_data)
        if not asset_path:
            continue

        try:
            package_path = str(asset_data.package_path)
        except Exception:
            package_path = ""

        records.append(
            {
                "asset_name": _asset_display_name(asset_data),
                "asset_path": asset_path,
                "package_path": package_path,
                "parent_class": _asset_tag(asset_data, "ParentClass"),
            }
        )

    records.sort(key=lambda record: record["asset_path"].lower())
    return records


def _load_generated_class(asset_path):
    loader = getattr(unreal.EditorAssetLibrary, "load_blueprint_class", None)
    if callable(loader):
        try:
            generated_class = loader(asset_path)
            if generated_class:
                return generated_class
        except Exception:
            pass

    try:
        blueprint = unreal.EditorAssetLibrary.load_asset(asset_path)
    except Exception:
        return None

    if not blueprint:
        return None

    generated_class = getattr(blueprint, "generated_class", None)
    if generated_class:
        return generated_class

    return None


def _class_display_name(unreal_class):
    try:
        return str(unreal.SystemLibrary.get_class_display_name(unreal_class))
    except Exception:
        return ""


def _super_class_name(unreal_class):
    attribute = getattr(unreal_class, "get_super_class", None)
    if attribute is None:
        return ""

    parent_class = None
    if callable(attribute):
        try:
            parent_class = attribute()
        except Exception:
            parent_class = None
    else:
        parent_class = attribute

    if not parent_class:
        return ""

    return _class_display_name(parent_class)


def _classify_blueprints(records, max_blueprints):
    game_modes = []
    characters = []
    pawns = []
    failures = []
    unresolved = 0
    inspected = 0
    truncated = len(records) > max_blueprints

    for record in records[:max_blueprints]:
        generated_class = _load_generated_class(record["asset_path"])
        if generated_class is None:
            if len(failures) < 10:
                failures.append(record["asset_path"])
            continue

        inspected += 1

        default_object = None
        try:
            default_object = unreal.get_default_object(generated_class)
        except Exception:
            default_object = None

        if default_object is None:
            unresolved += 1
            continue

        family = ""
        if hasattr(unreal, "GameModeBase") and isinstance(
            default_object, unreal.GameModeBase
        ):
            family = "game_mode"
        elif hasattr(unreal, "GameMode") and isinstance(default_object, unreal.GameMode):
            family = "game_mode"
        elif hasattr(unreal, "Character") and isinstance(
            default_object, unreal.Character
        ):
            family = "character"
        elif hasattr(unreal, "Pawn") and isinstance(default_object, unreal.Pawn):
            family = "pawn"

        if not family:
            continue

        native_parent = _native_class_name(record["parent_class"])
        detail = {
            "asset_name": record["asset_name"],
            "asset_path": record["asset_path"],
            "class_name": _class_display_name(generated_class),
            "parent_class": record["parent_class"] or _super_class_name(generated_class),
            "native_parent_class": native_parent,
            "family": family,
            "verified_by": "class_default_object",
        }

        if family == "game_mode":
            game_modes.append(detail)
        elif family == "character":
            characters.append(detail)
        else:
            pawns.append(detail)

    for collection in (game_modes, characters, pawns):
        collection.sort(key=lambda detail: detail["asset_path"].lower())

    return {
        "game_modes": game_modes,
        "characters": characters,
        "pawns": pawns,
        "inspected": inspected,
        "failed": len(failures),
        "failed_samples": failures,
        "unresolved": unresolved,
        "truncated": truncated,
        "candidate_count": len(records),
    }


def _scan_project_sources():
    project_path = Path(unreal.Paths.project_dir())
    roots = []
    modules = []
    file_counts = {"headers": 0, "cpp": 0, "cs": 0, "total": 0}
    max_files = 20000
    truncated = False

    source_root = project_path / "Source"
    if source_root.is_dir():
        roots.append(str(source_root.resolve()))

    plugins_root = project_path / "Plugins"
    if plugins_root.is_dir():
        try:
            for plugin_name in sorted(os.listdir(str(plugins_root))):
                plugin_source = plugins_root / plugin_name / "Source"
                if plugin_source.is_dir():
                    roots.append(str(plugin_source.resolve()))
        except OSError:
            pass

    if not roots:
        return {
            "roots": [],
            "modules": [],
            "file_counts": file_counts,
            "total_files": 0,
            "truncated": False,
            "message": "No Source directories were found in the project or its plugins.",
        }

    for root in roots:
        root_path = Path(root)
        try:
            for entry in sorted(os.listdir(str(root_path))):
                module_dir = root_path / entry
                if not module_dir.is_dir():
                    continue
                try:
                    for file_name in os.listdir(str(module_dir)):
                        if file_name.endswith(".Build.cs"):
                            modules.append(entry)
                            break
                except OSError:
                    continue
        except OSError:
            continue

    for root in roots:
        for current_dir, _dir_names, file_names in os.walk(root):
            for file_name in file_names:
                if file_counts["total"] >= max_files:
                    truncated = True
                    break

                lowered = file_name.lower()
                if lowered.endswith((".h", ".hpp", ".inl")):
                    file_counts["headers"] += 1
                elif lowered.endswith((".cpp", ".cc", ".cxx")):
                    file_counts["cpp"] += 1
                elif lowered.endswith(".cs"):
                    file_counts["cs"] += 1
                else:
                    continue

                file_counts["total"] += 1

            if truncated:
                break
        if truncated:
            break

    modules = sorted(set(modules))
    return {
        "roots": roots,
        "modules": modules,
        "file_counts": file_counts,
        "total_files": file_counts["total"],
        "truncated": truncated,
    }


def project_info(args):
    max_items = _clamp_int(args.get("max_items"), 25, 1, 200)
    max_blueprints = _clamp_int(args.get("max_blueprints"), 500, 1, 5000)

    warnings = []

    project_file_path = unreal.Paths.get_project_file_path()
    project_directory = unreal.Paths.project_dir()

    try:
        enabled_plugins = get_enabled_plugins()
    except Exception:
        enabled_plugins = []
        warnings.append("Enabled plugin list is unavailable; plugin-derived flags may be false.")

    try:
        classic_input = get_classic_input_mappings()
    except Exception:
        classic_input = {"action_mappings": [], "axis_mappings": []}
        warnings.append("Classic input mappings could not be read from Config/DefaultInput.ini.")

    asset_registry = unreal.AssetRegistryHelpers.get_asset_registry()

    registry_loading = False
    is_loading = getattr(asset_registry, "is_loading_assets", None)
    if callable(is_loading):
        try:
            registry_loading = bool(is_loading())
        except Exception:
            registry_loading = False

    if registry_loading:
        warnings.append(
            "The asset registry is still scanning. Asset counts and Blueprint classification may be incomplete; rerun after the scan finishes."
        )

    all_assets = asset_registry.get_all_assets()

    asset_locations = {}
    input_actions = []
    input_mappings = []
    experiences = []
    weapons = []
    maps = []
    blueprint_records = []

    for asset_data in all_assets:
        try:
            asset_name = _asset_display_name(asset_data)
            package_path = str(asset_data.package_path)
            class_name = get_asset_class_name(asset_data).lower()
        except Exception:
            continue

        asset_name_lower = asset_name.lower()
        full_path = _asset_path_of(asset_data) or "{0}/{1}".format(
            package_path, asset_name
        )

        location = package_path.split("/")[1] if "/" in package_path else "Root"
        asset_locations[location] = asset_locations.get(location, 0) + 1

        if asset_name.startswith("IA_"):
            input_actions.append(full_path)
        elif asset_name.startswith("IMC_"):
            input_mappings.append(full_path)

        if class_name == "blueprint":
            blueprint_records.append(asset_data)

        # Category heuristics are computed independently. The legacy script used
        # one elif chain, so a name containing "character" could never also be a
        # map; that coupling produced false empty lists.
        if "experience" in asset_name_lower and "ui" not in package_path.lower():
            experiences.append(full_path)
        if any(term in asset_name_lower for term in ["weapon", "wid_"]):
            weapons.append(full_path)
        if class_name == "world" or asset_name.startswith("L_"):
            maps.append(full_path)

    classification = _classify_blueprints(
        _collect_blueprint_assets(blueprint_records), max_blueprints
    )

    game_modes_detail = classification["game_modes"]
    characters_detail = classification["characters"] + classification["pawns"]

    if classification["truncated"]:
        warnings.append(
            "Only the first {0} of {1} Blueprint assets were inspected for game mode and character classes.".format(
                max_blueprints, classification["candidate_count"]
            )
        )

    if classification["failed"]:
        warnings.append(
            "{0} Blueprint assets could not be loaded for class inspection (for example: {1}).".format(
                classification["failed"],
                ", ".join(classification["failed_samples"][:3]),
            )
        )

    if classification["unresolved"]:
        warnings.append(
            "Class default objects were unavailable for {0} Blueprint assets; their ancestry could not be verified.".format(
                classification["unresolved"]
            )
        )

    if classification["candidate_count"] == 0 and not registry_loading:
        warnings.append(
            "No Blueprint assets were found in the asset registry, so game mode and character lists are empty rather than misclassified."
        )
    elif not game_modes_detail and not registry_loading:
        warnings.append(
            "{0} Blueprint assets were inspected but none derive from GameMode or GameModeBase.".format(
                classification["inspected"]
            )
        )

    if not characters_detail and not registry_loading:
        warnings.append(
            "{0} Blueprint assets were inspected but none derive from Character or Pawn.".format(
                classification["inspected"]
            )
        )

    source_summary = _scan_project_sources()
    if source_summary.get("truncated"):
        warnings.append(
            "Source scan stopped after {0} files; counts are a lower bound.".format(
                20000
            )
        )
    if source_summary.get("message"):
        warnings.append(source_summary["message"])

    input_systems = []
    enhanced_input_enabled = (
        "enhancedinput" in enabled_plugins
        or len(input_actions) > 0
        or len(input_mappings) > 0
    )
    classic_input_enabled = bool(
        classic_input["action_mappings"] or classic_input["axis_mappings"]
    )

    if enhanced_input_enabled:
        input_systems.append("enhanced_input")
    if classic_input_enabled:
        input_systems.append("classic_input")

    if not game_modes_detail and not characters_detail and classification["inspected"] == 0:
        warnings.append(
            "Game mode and character detection is empty because no Blueprint class could be inspected; this is a detection gap, not an empty project."
        )

    result = {
        "success": True,
        "project_name": project_file_path.split("/")[-1].replace(".uproject", "")
        if project_file_path
        else "Unknown",
        "project_directory": project_directory,
        "engine_version": unreal.SystemLibrary.get_engine_version(),
        "total_assets": len(all_assets),
        "asset_registry_loading": registry_loading,
        "asset_locations": dict(
            sorted(asset_locations.items(), key=lambda item: item[1], reverse=True)[:10]
        ),
        "enhanced_input_enabled": enhanced_input_enabled,
        "classic_input_enabled": classic_input_enabled,
        "input_systems": input_systems,
        "input_actions": input_actions[:10],
        "input_mappings": input_mappings[:10],
        "input_actions_count": len(input_actions),
        "input_mappings_count": len(input_mappings),
        "classic_input_actions": classic_input["action_mappings"],
        "classic_axis_mappings": classic_input["axis_mappings"],
        "classic_input_actions_count": len(classic_input["action_mappings"]),
        "classic_axis_mappings_count": len(classic_input["axis_mappings"]),
        "game_modes": [detail["asset_path"] for detail in game_modes_detail][:max_items],
        "game_modes_detail": game_modes_detail[:max_items],
        "total_game_modes": len(game_modes_detail),
        "characters": [detail["asset_path"] for detail in characters_detail][:max_items],
        "characters_detail": characters_detail[:max_items],
        "total_characters": len(characters_detail),
        "characters_truncated": len(characters_detail) > max_items,
        "experiences": experiences[:max_items],
        "weapons": weapons[:10],
        "maps": maps[:10],
        "gameplay_ability_system": "gameplayabilities" in enabled_plugins,
        "modular_gameplay": "modulargameplay" in enabled_plugins,
        "python_scripting": True,
        "networking": True,
        "total_maps": len(maps),
        "total_weapons": len(weapons),
        "total_experiences": len(experiences),
        "total_blueprints": classification["candidate_count"],
        "source": source_summary,
        "warnings": warnings,
    }

    if len(game_modes_detail) > max_items:
        result["game_modes_truncated"] = True
        result["warnings"].append(
            "Only the first {0} of {1} game mode classes are listed; raise max_items for the full list.".format(
                max_items, len(game_modes_detail)
            )
        )

    return result


OPERATIONS = {
    "create_input_mapping": create_input_mapping,
    "project_info": project_info,
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
                    "message": "Unknown project tool operation: {0}".format(
                        operation
                    ),
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
