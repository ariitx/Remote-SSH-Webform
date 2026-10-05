# Remote SSH WebForm

Build, run and debug classic ASP.NET (.NET Framework Web Forms / Web API) projects under IIS Express from VS Code, when VS Code is connected to a Windows machine over **Remote-SSH** (for example, a Mac editing a Windows VM). Launch profiles come from Visual Studio's `.slnLaunch` files.

The extension runs on the Windows side (`extensionKind: workspace`), so install it in the Remote-SSH window.

## Requirements (on the Windows host)

- Visual Studio 2022 or Build Tools for Visual Studio 2022 (MSBuild, found via `vswhere`)
- IIS Express
- The C# extension (`ms-dotnettools.csharp`), which provides the `clr` debugger. It's installed automatically as a dependency.

## Usage

The status bar shows the selected profile plus Debug / Run buttons (or Stop and Reload while sites run).

- **Select Launch Profile**: lists every profile in `*.slnLaunch` / `*.slnLaunch.user` (the `.user` file wins, as in Visual Studio), plus each IIS Express web project on its own. The choice is remembered per workspace.
  - For a solution (`.sln` / `.slnx`) without a `.slnLaunch`, the list offers **Create `<Solution>.slnLaunch`**. It writes one profile per web project that has an `<IISUrl>`, plus an "All web projects" profile, next to the solution, where Visual Studio also reads it. Edit the file to combine projects into your own profiles.
- **Debug Profile**: builds the profile's projects, starts IIS Express for each web project, and attaches the debugger to each `Action: "Start"` project's process by PID. In a Remote-SSH window, every site's port is then forwarded, so each one also answers on `localhost:<port>` on the client, including an API that another site's pages call.
- **Run Profile**: the same without attaching.
- **Build Profile**: builds only; errors appear in the Problems panel.
- **Build Solution** (status bar wrench button): builds the whole solution behind the selected profile (or asks which one when that's ambiguous), restoring NuGet packages first. Use it after pulling changes to referenced projects, since the profile builds skip project references by default.
- **Stop IIS Express**: stops only the IIS Express processes this extension started.
- **Reload** (status bar restart button, beside Stop): stops the sites, rebuilds the profile (changed references included), starts IIS Express again and, if the sites were started with Debug, reattaches the debugger.
- **Open Site in Browser**: opens a running site on the client machine through its forwarded port.
- **Regenerate Designer File** (right-click an `.aspx`, `.ascx` or `.master`): brings its `.designer.cs` / `.designer.vb` up to date. This also happens automatically on save; see below.
- **Visualize as Table** (right-click a variable in the code, Variables or Watch while debugging): shows a DataTable, DataSet, list, array or dictionary as a sortable, filterable table; see below.
- **Toggle Markup / Code-Behind** (F7, or right-click in the editor): switches between an `.aspx`, `.ascx`, `.master`, `.asmx`, `.ashx` or `.asax` and its code-behind, like Visual Studio's View Code. It follows the `CodeBehind` / `CodeFile` attribute, falling back to `<markup>.cs` / `.vb`. From a code-behind or `.designer` file it goes back to the markup. On a Mac keyboard, press fn+F7 unless the function keys are set as standard keys.

## Designer files

Visual Studio keeps `Foo.aspx.designer.cs` in sync with the markup; VS Code doesn't. With this extension, saving an `.aspx`, `.ascx` or `.master` updates its designer file the same way, so a control you add in the markup can be used from the code-behind straight away.

- **Which controls get a field**: every server control with an `ID`, plus ID'd collection items such as DevExpress custom buttons. Controls inside templates (`ItemTemplate`, `DataItemTemplate`, DevExpress `<Templates>`, …) don't, because ASP.NET creates them once per row; use `FindControl` for those. `UpdatePanel`'s `ContentTemplate` is the exception, as in Visual Studio. A field the code-behind already declares is left out.
- **Types** come from `<%@ Register %>` directives, `web.config` `<pages><controls>`, the `Inherits` of registered user controls, and the type names in the referenced assemblies (project `bin`, `HintPath`, the .NET Framework folder and the GAC). When a prefix maps to several namespaces, as DevExpress's `dx` often does, the assembly that defines the type wins.
- **Existing files are edited in place**: existing fields keep their order, new ones are appended, removed ones are dropped, and the header and formatting stay as they are. A designer file whose fields already match isn't touched.
- **New pages**: when the designer file doesn't exist yet (the page needs a `CodeBehind` attribute), it is created in Visual Studio 2022's format and added to the `.csproj` / `.vbproj` with `<DependentUpon>`. Add the page and its code-behind to the project yourself.
- **Not handled**: `<%@ MasterType %>` / `<%@ PreviousPageType %>` properties, and Web Site projects (`CodeFile`), which have no designer files. If a control's type can't be resolved, it gets no field and the Remote SSH WebForm output says why.

Turn it off with `remoteSshWebForm.generateDesignerOnSave`.

## Visualize as Table

VS Code has no equivalent of Visual Studio's DataSet and collection visualizers. While a .NET debug session is paused (`clr` or `coreclr`, C# or VB.NET), this one shows a value as a table:

- **In the code**: right-click a variable name > **Visualize as Table**. It takes the member chain up to the name you clicked, including indexers (on `Rows` in `ds.Tables[0].Rows.Count`, that's `ds.Tables[0].Rows`); select text to use exactly that expression instead.
- **In a hover**: hold **Alt** (Option on a Mac) while hovering a variable in the stopped file. VS Code then shows the language hover instead of the debug hover, with a **Visualize as Table** link. In other files the link is in the normal hover. Extensions can't add to the debug hover itself.
- **In Run and Debug > Variables or Watch**: right-click a variable > **Visualize as Table**, or click the table icon on its row. The icon also shows on the rows inside the debug hover (the members of what you hover, not the hovered value itself). Both appear for collection-like types.
- **From the Command Palette**: **Visualize Expression as Table...**, then type a C# expression (the editor selection is suggested).

The debugger evaluates C# syntax even in VB.NET code (`Me.` is turned into `this.`), and names are case-sensitive, so a VB.NET name must be spelled as declared.

Each expression gets one table, which opens beside the editor. It reads the value again whenever the debugger stops (after a step, at the next breakpoint) and on **Refresh**. While the program runs, or after the session ends, it keeps the last values and says so.

**Supported values**: `DataTable` (typed tables too), `DataSet` (one tab per table), `DataView` (rows after its filter and sort), `DataRow[]` (e.g. `table.Select(...)`), arrays, `List<T>`, `Dictionary<TKey, TValue>` (Key / Value columns) and any other `IEnumerable`, including LINQ queries. Objects get a column per public property and field; scalars get a Value column. Nulls, empty tables and errors show a message instead.

**In the table**: click a header to sort (again to reverse, a third time for the original order); type in Filter rows to keep the rows containing the text. Column headers show the CLR type. Nested objects and collections show as one line of JSON; click ▸ to expand. Right-click a cell to copy it, its row, its column or the table as tab-separated text (Ctrl+C copies the selected cell). **Copy** and **Export CSV** use the rows shown, in the order shown.

**Rows**: the first `remoteSshWebForm.tableVisualizer.maxRows` (default 1000) rows or items are read, and the total count is shown. A sequence without a `Count` is read only up to that limit, so its total shows as "more".

**How it reads values**: through the debugger's `evaluate` request, in the stack frame selected in Call Stack.

- **The helper assembly** comes first. On the first read in a process, a small assembly built from [debuggee/](debuggee/) is loaded into the debugged program (`Assembly.LoadFrom`), and each read is one call into it. This is how Visual Studio's own visualizers work. It reads 1,000 objects in about 0.1 s, catches exceptions from property getters per cell (shown as `(Name threw ...)`), and stops at reference cycles and after three nesting levels. The assembly is loaded from a copy in the temp folder, so a running IIS Express doesn't lock the extension's files. It stays loaded until the program exits.
- **Debugger expressions** are the fallback when the helper can't be loaded, for example when the program runs on another machine. They use System.Text.Json or Newtonsoft.Json if the program has already loaded them, and otherwise a reflection expression. They are slower: about 6 s for 1,000 objects. In this mode nested objects show only their type name.

**Limitations**

- VS Code's own debug visualizer API (`registerDebugVisualizationProvider`) is still a proposed API that Marketplace extensions can't use. So the entry point is a context-menu item instead of an inline button.
- Reading a value runs code in the program: property getters, and the query behind a LINQ or `IQueryable` value. Anything a getter does (lazy loading, logging) happens, just as when you expand the value in Variables.
- Strings longer than 10,000 characters are cut. 64-bit integers and decimals are shown as text, so they keep their precision; they still sort as numbers.
- With the fallback on .NET Framework (`clr`), vsdbg evaluates larger expressions unreliably. Tables and lists may then fail to read, with the reason shown. The helper path doesn't have this problem.
- The debugger has to be able to run code where it is stopped, so a value can't be read in optimized code or while a native frame is on top of the stack.

The [sample/](sample/) folder has a console program with a DataTable, a DataSet, a DataView, lists (including one with 5,000 items), dictionaries, arrays and null values, in C# for .NET 9 and .NET Framework 4.8, and in VB.NET. Open the folder, set a breakpoint on a `BREAK` line and start one of its launch configurations.

## Changing code while debugging

Edit and Continue isn't available. For .NET Framework it exists only in Visual Studio; the VS Code `clr` debugger doesn't support it, and C# Hot Reload in VS Code covers .NET 6+ only. How to get changes into a running site:

- **Markup** (`.aspx`, `.ascx`, `.master`), JavaScript and CSS: save and refresh the browser. ASP.NET compiles markup at runtime. Saving `Web.config` restarts the application automatically.
- **Code-behind and other C#/VB code**: press **Reload**, which stops IIS Express, rebuilds, restarts it and reattaches.

## How it works

- **Projects**: C# (`.csproj`) and VB.NET (`.vbproj`) web application projects.
- **Ports** come from each project's `<IISUrl>` (the `.user` file first, then the project file).
- **Config**: a standalone `applicationhost.config` is generated in the extension's workspace storage from IIS Express's own template, so Visual Studio's `.vs\...\applicationhost.config` is never touched.
- **Bindings** use a blank hostname (`*:<port>:`) so a site answers on the Windows machine's IP or hostname, not only `localhost`. Without this, requests to the IP get `503`. When VS Code isn't elevated, the extension adds the needed URL reservation (`netsh http add urlacl`), or logs the command to run once elevated.
- **HTTPS** works for ports that already have a certificate bound. IIS Express pre-binds its development certificate to ports 44300–44399.
- **One IIS Express process per site**, each in its own terminal. IIS Express serves a single site per process.
- **Non-web projects** in a profile (e.g. `WinExe` tools) are built but not started, with a note in the output.
- **Build** clears `NoDefaultCurrentDirectoryInExePath` so pre/post-build events that call batch files by bare name don't fail with `MSB3073` / exit `9009`. By default it builds with `BuildProjectReferences=false`, so a broken, unrelated project elsewhere in the solution can't block a debug session.
- **Changed references** are built first. Before building the profile's projects, the extension follows their `<ProjectReference>`s, including references of references. It builds, dependencies first, every referenced project whose output is missing or older than a file in its folder (minus `bin`, `obj` and nested projects), its project file or a linked file. It also builds every project that depends on one of those. Unchanged references aren't built, and the Remote SSH WebForm output lists what was built and why. If a reference fails to build, the build stops there. Turn it off with `buildChangedReferences`; it's skipped when `buildProjectReferences` is on.

## Settings

All settings are under `remoteSshWebForm.*`: `configuration`, `platform`, `solutionPlatform`, `restoreBeforeSolutionBuild`, `debugType` (default `portable`, required by the `clr` debugger), `buildProjectReferences`, `buildChangedReferences`, `buildBeforeRun`, `additionalMsbuildArgs`, `msbuildPath`, `iisExpressPath`, `applicationPool`, `bindAllHostnames`, `justMyCode`, `stopSitesWhenDebuggingStops`, `startupTimeoutSeconds`, `generateDesignerOnSave`, `tableVisualizer.maxRows`.

## Development

```
npm install
npm run compile
npm test          # compiles, then runs the tests
npm run package   # produces remote-ssh-webform-<version>.vsix
```

`npm run compile` also builds the table visualizer's helper assembly ([debuggee/](debuggee/), into `out/debuggee/`), so it needs the .NET SDK. `npm run compile:debuggee` builds only that.

Press F5 in this folder to launch an Extension Development Host. To try Visualize as Table there, open [sample/](sample/) in it and start one of its launch configurations.

### Tests

The tests in [src/test/](src/test/) use Node's built-in test runner (`node:test`), so they need no extra dependencies and no VS Code instance. Each test builds a throwaway project in the temp folder and deletes it afterwards. They aren't packaged into the `.vsix`.

| File | Covers |
| --- | --- |
| `designer.test.ts` | Which controls get designer fields (templates, collection items, comments, `<script>` blocks, `<head>` children, code-behind declarations), type resolution, the F7 markup / code-behind lookup, in-place updates, new-file formats, project-file entries |
| `clrMetadata.test.ts` | Reading public type names from an assembly, and invalid or missing files |
| `slnLaunch.test.ts` | `.slnLaunch` parsing and generation, `.sln` / `.slnx` project lists, profile ids, web-project detection and `<IISUrl>` lookup |
| `sites.test.ts` | Resolving a profile to IIS Express sites (ports, app paths, skipped projects), and the generated `applicationhost.config` |
| `msbuild.test.ts` | The MSBuild task and its PowerShell script; on Windows it runs that script against a stand-in MSBuild, to check the arguments MSBuild really receives (e.g. `SolutionDir` with spaces) |
| `profiles.test.ts` | Profile discovery, such as a `.slnLaunch.user` replacing its `.slnLaunch` |
| `util.test.ts` | Quoting, encoding and process helpers |
| `editorExpression.test.ts` | Finding the expression under the cursor for the editor menu and hover: member chains, indexers, `?.`, VB.NET `Me.`, and skipping keywords, calls, strings (but not interpolation holes) and comments |
| `visualizerSerializers.test.ts` | The C# expressions Visualize as Table evaluates: well-formed, the user's expression evaluated once, lambda parameters that can't clash with locals, LINQ called statically, the row limit, the helper call |
| `visualizerPayload.test.ts` | Decoding the debugger's C# string literals, telling values from compile errors and exceptions, type detection (typed DataTables, dictionaries, arrays), laying out rows and columns, readable type names |
| `visualizerInspect.test.ts` | Reading a value against a scripted debugger: the helper, falling back to expressions, skipping serializers whose library isn't loaded, counting sequences without `Count`, and the messages for null, out-of-scope, unsupported and failing values |
| `tableCore.test.ts` | The table page's logic: cell text, numeric and text sorting with empty values last, filtering, TSV and CSV |

- `msbuild.ts` and `profiles.ts` import `vscode`, so their tests load [vscodeHook.ts](src/test/vscodeHook.ts) first. It points `vscode` at a small stub ([vscodeStub.ts](src/test/vscodeStub.ts)) that records tasks and serves `findFiles` results.
- Tests that need Windows, the .NET Framework 4.x assemblies or IIS Express are skipped where those are missing.
- Not covered: starting and stopping IIS Express processes (`iisexpress.ts`), the VS Code UI in `extension.ts`, and the table visualizer's webview and its real debugger sessions. Check those by hand in an Extension Development Host, with the [sample](sample/) for the visualizer.

Run a single file with `node --test out/test/sites.test.js` after `npm run compile`.
