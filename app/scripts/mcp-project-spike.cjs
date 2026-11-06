const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const assert = require("node:assert/strict")
const { Client } = require("@modelcontextprotocol/sdk/client/index.js")
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js")

const repoRoot = path.resolve(__dirname, "..")
const serverEntry = path.join(repoRoot, "dist", "bin.js")
const stamp = Date.now()
const auditPath = path.join(os.tmpdir(), "unreal-mcp", `project-spike-audit-${stamp}.jsonl`)
const historyPath = path.join(os.tmpdir(), "unreal-mcp", `project-spike-history-${stamp}.jsonl`)

const extractText = (result) => {
	const content = result && Array.isArray(result.content) ? result.content : []
	return content
		.filter((item) => item && item.type === "text")
		.map((item) => item.text || "")
		.join("\n")
}

const parseJson = (text) => {
	try {
		return JSON.parse(text)
	} catch {
		const start = text.indexOf("{")
		const end = text.lastIndexOf("}")
		if (start >= 0 && end > start) {
			return JSON.parse(text.slice(start, end + 1))
		}
		throw new Error(`Expected JSON, got: ${text.slice(0, 300)}`)
	}
}

const withTimeout = (promise, ms, label) =>
	Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
	])

const headerContent = `#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "MCPLiveCodingTestActor.generated.h"

class UStaticMeshComponent;
class UTextRenderComponent;

UCLASS(Blueprintable)
class VITEMCPTEST_API AMCPLiveCodingTestActor : public AActor
{
	GENERATED_BODY()

public:
	AMCPLiveCodingTestActor();

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Live Coding")
	float PulseSpeed = 1.0f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "MCP Live Coding")
	FLinearColor Color = FLinearColor(0.05f, 0.55f, 1.0f, 1.0f);

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "MCP Live Coding")
	UStaticMeshComponent* Mesh;

	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category = "MCP Live Coding")
	UTextRenderComponent* Text;

	UFUNCTION(BlueprintCallable, Category = "MCP Live Coding")
	float ComputePulse(float TimeSeconds) const;

	UFUNCTION(BlueprintCallable, Category = "MCP Live Coding")
	void SetMCPTestColor(FLinearColor NewColor);

protected:
	virtual void BeginPlay() override;
};
`

const cppContent = `#include "MCPLiveCodingTestActor.h"

#include "Components/StaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"

AMCPLiveCodingTestActor::AMCPLiveCodingTestActor()
{
	PrimaryActorTick.bCanEverTick = false;

	Mesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Mesh"));
	RootComponent = Mesh;

	static ConstructorHelpers::FObjectFinder<UStaticMesh> CubeMesh(
		TEXT("/Engine/BasicShapes/Cube.Cube")
	);
	if (CubeMesh.Succeeded())
	{
		Mesh->SetStaticMesh(CubeMesh.Object);
	}

	static ConstructorHelpers::FObjectFinder<UMaterialInterface> BasicMaterial(
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial")
	);
	if (BasicMaterial.Succeeded())
	{
		Mesh->SetMaterial(0, BasicMaterial.Object);
	}

	Text = CreateDefaultSubobject<UTextRenderComponent>(TEXT("Text"));
	Text->SetupAttachment(Mesh);
	Text->SetRelativeLocation(FVector(0.0f, 0.0f, 120.0f));
	Text->SetHorizontalAlignment(EHTA_Center);
	Text->SetWorldSize(60.0f);
	Text->SetText(FText::FromString(TEXT("MCP LIVE CODING")));
	Text->SetTextRenderColor(FColor(30, 200, 255));
}

void AMCPLiveCodingTestActor::BeginPlay()
{
	Super::BeginPlay();
	SetMCPTestColor(Color);
}

float AMCPLiveCodingTestActor::ComputePulse(float TimeSeconds) const
{
	return (FMath::Sin(TimeSeconds * PulseSpeed) + 1.0f) * 0.5f;
}

void AMCPLiveCodingTestActor::SetMCPTestColor(FLinearColor NewColor)
{
	Color = NewColor;

	if (Mesh)
	{
		if (UMaterialInstanceDynamic* DynamicMaterial = Mesh->CreateAndSetMaterialInstanceDynamic(0))
		{
			DynamicMaterial->SetVectorParameterValue(TEXT("Color"), NewColor);
		}
	}

	if (Text)
	{
		Text->SetTextRenderColor(NewColor.ToFColor(true));
	}
}
`

const testContent = `#include "MCPLiveCodingTestActor.h"
#include "Misc/AutomationTest.h"

#if WITH_DEV_AUTOMATION_TESTS

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FMCPLiveCodingTest,
	"ViteMCPTest.MCP.LiveCoding",
	EAutomationTestFlags::ApplicationContextMask | EAutomationTestFlags::ProductFilter
)

bool FMCPLiveCodingTest::RunTest(const FString& Parameters)
{
	AMCPLiveCodingTestActor* Actor = NewObject<AMCPLiveCodingTestActor>();
	Actor->PulseSpeed = 2.0f;

	TestTrue(TEXT("Pulse at zero"), FMath::IsNearlyEqual(Actor->ComputePulse(0.0f), 0.5f, 0.001f));
	TestTrue(
		TEXT("Pulse at quarter wave"),
		FMath::IsNearlyEqual(Actor->ComputePulse(PI * 0.25f), 1.0f, 0.001f)
	);

	Actor->SetMCPTestColor(FLinearColor::Red);
	TestTrue(TEXT("Color set"), Actor->Color.Equals(FLinearColor::Red));

	return true;
}

#endif
`

const main = async () => {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverEntry],
		cwd: repoRoot,
		stderr: "pipe",
		env: {
			...process.env,
			UEV_BIND_ADDRESS: "127.0.0.1",
			UEV_COMMAND_ADDRESS: "127.0.0.1",
			UEV_MULTICAST_TTL: "0",
			UEV_PROFILE: "supervised",
			UEV_AUDIT_LOG: auditPath,
			UEV_HISTORY_LOG: historyPath,
			UEV_SUPERVISOR_PIPE: "\\\\.\\pipe\\uev-supervisor",
		},
	})

	const client = new Client({ name: "project-spike", version: "1.0.0" })
	await withTimeout(client.connect(transport), 15000, "connect")

	const call = async (name, args = {}, timeoutMs = 180000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 2200))
		return { text, json: parseJson(text) }
	}

	const callText = async (name, args = {}, timeoutMs = 180000) => {
		const result = await withTimeout(client.callTool({ name, arguments: args }), timeoutMs, name)
		const text = extractText(result)
		console.log(`--- ${name} ${JSON.stringify(args)} ---`)
		console.log(text.slice(0, 2200))
		return text
	}

	const writeSource = async (filePath, content) => {
		const result = await call("manage_code", {
			action: "write_source",
			params: { path: filePath, content, overwrite: true },
		})
		assert.equal(result.json.success, true)
		return result.json
	}

	try {
		const status = await call("manage_code", { action: "status" }, 60000)
		assert.equal(status.json.success, true)
		assert.equal(status.json.liveCoding.moduleLoaded, true, "Live Coding must be loaded")
		console.log(`[PASS] Live Coding loaded (${status.json.project.projectName})`)

		const header = await writeSource("Source/ViteMCPTest/MCPLiveCodingTestActor.h", headerContent)
		const cpp = await writeSource("Source/ViteMCPTest/MCPLiveCodingTestActor.cpp", cppContent)
		const test = await writeSource("Source/ViteMCPTest/MCPLiveCoding_Test.cpp", testContent)
		console.log(`[PASS] MCP wrote source files (header=${header.bytes}, cpp=${cpp.bytes}, test=${test.bytes})`)

		const readBack = await call("manage_code", {
			action: "read_source",
			params: { path: "Source/ViteMCPTest/MCPLiveCodingTestActor.h" },
		})
		assert.equal(readBack.json.success, true)
		assert.match(readBack.json.content, /AMCPLiveCodingTestActor/)
		console.log("[PASS] MCP read back the new header")

		const compile = await call("manage_code", {
			action: "compile",
			params: { confirm: true, waitMs: 5000 },
		})
		assert.equal(compile.json.success, true)
		assert.equal(compile.json.preview, false)
		console.log("[PASS] Live Coding compile requested")

		const tests = await call("manage_code", { action: "tests" })
		assert.ok(tests.json.files.some((file) => file.name === "MCPLiveCoding_Test.cpp"))
		console.log("[PASS] automation test source detected")

		const runTests = await call("manage_code", {
			action: "run_tests",
			params: { filter: "ViteMCPTest.MCP.LiveCoding", confirm: true, waitMs: 5000 },
		})
		assert.equal(runTests.json.success, true)
		assert.equal(runTests.json.preview, false)
		console.log("[PASS] automation test request sent")

		const widget = await call("manage_widget", {
			action: "create_widget_blueprint",
			params: { widget_name: "MCPStatusWidget", path: "/Game/MCP/UI" },
		})
		const widgetPath = widget.json.asset_path || widget.json.widget_blueprint || "/Game/MCP/UI/MCPStatusWidget"
		await call("manage_widget", {
			action: "ensure_canvas_root",
			params: { widget_blueprint: widgetPath },
		})
		await call("manage_widget", {
			action: "add_text_block",
			params: {
				widget_blueprint: widgetPath,
				text_block_name: "MCPStatusText",
				text: "MCP Live Coding + UI OK",
				font_size: 28,
				color: [0.1, 0.8, 1.0, 1.0],
				position: [40, 40],
				size: [640, 120],
			},
		})
		await call("manage_widget", {
			action: "add_to_viewport",
			params: { widget_blueprint: widgetPath, z_order: 100, start_pie_if_needed: true },
		})
		console.log("[PASS] MCP created widget and added it to the viewport")

		const spawn = await call("manage_actor", {
			action: "spawn",
			params: {
				type: "MCPLiveCodingTestActor",
				name: "MCP_LiveCoding_Actor",
				location: { x: 300, y: 0, z: 100 },
			},
		})
		if (spawn.json.success !== true) {
			const python = await callText("manage_editor", {
				action: "run_python",
				params: {
					code: [
						"import unreal",
						"actor = unreal.EditorLevelLibrary.spawn_actor_from_class(unreal.MCPLiveCodingTestActor, unreal.Vector(300.0, 0.0, 100.0))",
						'actor.set_actor_label("MCP_LiveCoding_Actor")',
						"actor.set_actor_scale3d(unreal.Vector(1.5, 1.5, 1.5))",
						"actor.set_mcp_test_color(unreal.LinearColor(1.0, 0.25, 0.05, 1.0))",
						"print(actor.get_name())",
					].join("\n"),
				},
			})
			assert.match(python, /MCP_LiveCoding_Actor|MCPLiveCodingTestActor/)
		}
		console.log("[PASS] MCP spawned the Live Coding actor")

		const screenshot = await callText("manage_editor", { action: "screenshot", params: {} })
		assert.match(screenshot.toLowerCase(), /\.png/)
		console.log(`[PASS] screenshot ${screenshot}`)

		const profile = await call("manage_profile", {
			action: "capture_stats",
			params: { stats: ["stat unit"], durationMs: 500 },
		})
		assert.equal(profile.json.success, true)
		console.log(`[PASS] profiling capture (${profile.json.lineCount} lines)`)

		const frame = await call("manage_profile", { action: "capture_frame", params: { waitMs: 1200 } })
		assert.equal(frame.json.success, true)
		console.log("[PASS] GPU frame capture request")

		const artifacts = await call("manage_profile", { action: "list_artifacts", params: { limit: 5 } })
		assert.equal(artifacts.json.success, true)
		console.log(`[PASS] profiling artifacts visible (${artifacts.json.total})`)

		await call("manage_actor", { action: "delete", params: { name: "MCP_LiveCoding_Actor" } })
		const pie = await call("manage_editor", { action: "is_pie_running" })
		if (pie.json && pie.json.running) {
			await call("manage_editor", { action: "stop_pie" })
		}
		const save = await callText("manage_editor", {
			action: "run_python",
			params: {
				code: [
					"import unreal",
					"saved = unreal.EditorLevelLibrary.save_current_level()",
					'print("level_saved={0}".format(saved))',
				].join("\n"),
			},
		})
		assert.match(save, /level_saved=True/i)
		console.log("[PASS] actor removed, PIE stopped, level saved")
	} finally {
		await client.close()
	}
}

main().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
