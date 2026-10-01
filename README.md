# Remote SSH WebForm

Build, run and debug classic ASP.NET (.NET Framework Web Forms / Web API) projects under IIS Express from VS Code, when VS Code is connected to a Windows machine over **Remote-SSH** (for example, a Mac editing a Windows VM). Launch profiles come from Visual Studio's `.slnLaunch` files.

The extension runs on the Windows side (`extensionKind: workspace`), so install it in the Remote-SSH window.

## Requirements (on the Windows host)

- Visual Studio 2022 or Build Tools for Visual Studio 2022 (MSBuild, found via `vswhere`)
- IIS Express
- The C# extension (`ms-dotnettools.csharp`), which provides the `clr` debugger. It's installed automatically as a dependency.

## Usage

The status bar shows the selected profile plus Debug / Run buttons (or Stop while sites run).

- **Select Launch Profile**: lists every profile in `*.slnLaunch` / `*.slnLaunch.user` (the `.user` file wins, as in Visual Studio), plus each IIS Express web project on its own. The choice is remembered per workspace.
  - For a solution (`.sln` / `.slnx`) without a `.slnLaunch`, the list offers **Create `<Solution>.slnLaunch`**. It writes one profile per web project that has an `<IISUrl>`, plus an "All web projects" profile, next to the solution, where Visual Studio also reads it. Edit the file to combine projects into your own profiles.
- **Debug Profile**: builds the profile's projects, starts IIS Express for each web project, and attaches the debugger to each `Action: "Start"` project's process by PID.
- **Run Profile**: the same without attaching.
- **Build Profile**: builds only; errors appear in the Problems panel.
- **Build Solution** (status bar wrench button): builds the whole solution behind the selected profile (or asks which one when that's ambiguous), restoring NuGet packages first. Use it after pulling changes to referenced projects, since the profile builds skip project references by default.
- **Stop IIS Express**: stops only the IIS Express processes this extension started.
- **Open Site in Browser**: opens a running site on the client machine, forwarding the port through Remote-SSH.
- **Regenerate Designer File** (right-click an `.aspx`, `.ascx` or `.master`): brings its `.designer.cs` / `.designer.vb` up to date. This also happens automatically on save; see below.

## Designer files

Visual Studio keeps `Foo.aspx.designer.cs` in sync with the markup; VS Code doesn't. With this extension, saving an `.aspx`, `.ascx` or `.master` updates its designer file the same way, so a control you add in the markup can be used from the code-behind straight away.

- **Which controls get a field**: every server control with an `ID`, plus ID'd collection items such as DevExpress custom buttons. Controls inside templates (`ItemTemplate`, `DataItemTemplate`, DevExpress `<Templates>`, …) don't, because ASP.NET creates them once per row; use `FindControl` for those. `UpdatePanel`'s `ContentTemplate` is the exception, as in Visual Studio. A field the code-behind already declares is left out.
- **Types** come from `<%@ Register %>` directives, `web.config` `<pages><controls>`, the `Inherits` of registered user controls, and the type names in the referenced assemblies (project `bin`, `HintPath`, the .NET Framework folder and the GAC). When a prefix maps to several namespaces, as DevExpress's `dx` often does, the assembly that defines the type wins.
- **Existing files are edited in place**: existing fields keep their order, new ones are appended, removed ones are dropped, and the header and formatting stay as they are. A designer file whose fields already match isn't touched.
- **New pages**: when the designer file doesn't exist yet (the page needs a `CodeBehind` attribute), it is created in Visual Studio 2022's format and added to the `.csproj` / `.vbproj` with `<DependentUpon>`. Add the page and its code-behind to the project yourself.
- **Not handled**: `<%@ MasterType %>` / `<%@ PreviousPageType %>` properties, and Web Site projects (`CodeFile`), which have no designer files. If a control's type can't be resolved, it gets no field and the Remote SSH WebForm output says why.

Turn it off with `remoteSshWebForm.generateDesignerOnSave`.

## Changing code while debugging

Edit and Continue isn't available. For .NET Framework it exists only in Visual Studio; the VS Code `clr` debugger doesn't support it, and C# Hot Reload in VS Code covers .NET 6+ only. How to get changes into a running site:

- **Markup** (`.aspx`, `.ascx`, `.master`), JavaScript and CSS: save and refresh the browser. ASP.NET compiles markup at runtime. Saving `Web.config` restarts the application automatically.
- **Code-behind and other C#/VB code**: **Stop IIS Express**, then **Debug Profile**, which rebuilds, restarts IIS Express and reattaches.

## How it works

- **Projects**: C# (`.csproj`) and VB.NET (`.vbproj`) web application projects.
- **Ports** come from each project's `<IISUrl>` (the `.user` file first, then the project file).
- **Config**: a standalone `applicationhost.config` is generated in the extension's workspace storage from IIS Express's own template, so Visual Studio's `.vs\...\applicationhost.config` is never touched.
- **Bindings** use a blank hostname (`*:<port>:`) so a site answers on the Windows machine's IP or hostname, not only `localhost`. Without this, requests to the IP get `503`. When VS Code isn't elevated, the extension adds the needed URL reservation (`netsh http add urlacl`), or logs the command to run once elevated.
- **HTTPS** works for ports that already have a certificate bound. IIS Express pre-binds its development certificate to ports 44300–44399.
- **One IIS Express process per site**, each in its own terminal. IIS Express serves a single site per process.
- **Non-web projects** in a profile (e.g. `WinExe` tools) are built but not started, with a note in the output.
- **Build** clears `NoDefaultCurrentDirectoryInExePath` so pre/post-build events that call batch files by bare name don't fail with `MSB3073` / exit `9009`. By default it builds with `BuildProjectReferences=false`, so a broken, unrelated project elsewhere in the solution can't block a debug session.

## Settings

All settings are under `remoteSshWebForm.*`: `configuration`, `platform`, `solutionPlatform`, `restoreBeforeSolutionBuild`, `debugType` (default `portable`, required by the `clr` debugger), `buildProjectReferences`, `buildBeforeRun`, `additionalMsbuildArgs`, `msbuildPath`, `iisExpressPath`, `applicationPool`, `bindAllHostnames`, `justMyCode`, `stopSitesWhenDebuggingStops`, `startupTimeoutSeconds`, `generateDesignerOnSave`.

## Development

```
npm install
npm run compile
npm test          # compiles, then runs the tests
npm run package   # produces remote-ssh-webform-<version>.vsix
```

Press F5 in this folder to launch an Extension Development Host.

### Tests

The tests in [src/test/](src/test/) use Node's built-in test runner (`node:test`), so they need no extra dependencies and no VS Code instance. Each test builds a throwaway project in the temp folder and deletes it afterwards. They aren't packaged into the `.vsix`.

| File | Covers |
| --- | --- |
| `designer.test.ts` | Which controls get designer fields (templates, collection items, comments, `<script>` blocks, `<head>` children, code-behind declarations), type resolution, in-place updates, new-file formats, project-file entries |
| `clrMetadata.test.ts` | Reading public type names from an assembly, and invalid or missing files |
| `slnLaunch.test.ts` | `.slnLaunch` parsing and generation, `.sln` / `.slnx` project lists, profile ids, web-project detection and `<IISUrl>` lookup |
| `sites.test.ts` | Resolving a profile to IIS Express sites (ports, app paths, skipped projects), and the generated `applicationhost.config` |
| `msbuild.test.ts` | The MSBuild task and its PowerShell script; on Windows it runs that script against a stand-in MSBuild, to check the arguments MSBuild really receives (e.g. `SolutionDir` with spaces) |
| `profiles.test.ts` | Profile discovery, such as a `.slnLaunch.user` replacing its `.slnLaunch` |
| `util.test.ts` | Quoting, encoding and process helpers |

- `msbuild.ts` and `profiles.ts` import `vscode`, so their tests load [vscodeHook.ts](src/test/vscodeHook.ts) first. It points `vscode` at a small stub ([vscodeStub.ts](src/test/vscodeStub.ts)) that records tasks and serves `findFiles` results.
- Tests that need Windows, the .NET Framework 4.x assemblies or IIS Express are skipped where those are missing.
- Not covered: starting and stopping IIS Express processes (`iisexpress.ts`) and the VS Code UI in `extension.ts`. Check those by hand in an Extension Development Host.

Run a single file with `node --test out/test/sites.test.js` after `npm run compile`.
