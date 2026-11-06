# Third-party notices

## UEV server

The bundled Node server is derived from the `unreal-mcp-ue4` project and preserves its MIT license and attribution in `payload/app/LICENSE` and `payload/app/README.md`.

## Node dependencies

The packaged production dependencies include `@modelcontextprotocol/sdk`, `zod`, `unreal-remote-execution`, and their transitive dependencies. Their license texts are included in their respective `node_modules` packages. `unreal-remote-execution` is MIT-0. The MCP SDK and zod are MIT.

## Node.js

The package includes the Node.js Windows executable. Node.js is licensed under the MIT license; the full license text is included at `payload/node/LICENSE`.

## Unreal Engine

The installer does not redistribute Unreal Engine or Epic Games plugin binaries. It expects a licensed UE 4.27 installation. `PythonScriptPlugin`, `EditorScriptingUtilities`, `SequencerScripting`, and Live Coding are engine components or engine plugins and remain subject to the Unreal Engine license.

`UEVNative` and `UEVControlPanel` are source-only editor plugins included in this package. They are compiled by the installer against the user's engine and project.
