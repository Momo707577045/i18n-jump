import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as http from "http";
import * as querystring from "querystring";
import {
  TextDocument,
  TextLine,
  Position,
  Location,
  Uri,
  Range,
  window,
  workspace,
  commands,
  Clipboard,
  languages,
  TextEditor,
  TextEditorEdit,
  ExtensionContext,
} from "vscode";

// 获取当前参数的全层级路径，
function getParamPaths(document: TextDocument, line: TextLine, firstWord: string) {
  let stackNum = 0;
  const namePath = [firstWord]; // 路径
  for (let index = line.lineNumber - 1; index > 0; index--) {
    const currentLine = document.lineAt(index).text;
    if (currentLine.includes("{") && currentLine.includes("}")) {
      continue;
    }
    if (currentLine.includes("{") && currentLine.includes(":")) {
      if (stackNum === 0) {
        namePath.unshift(currentLine.split(":")[0].trim());
      } else {
        stackNum--;
      }
    } else if (currentLine.includes("}")) {
      stackNum++;
    }
  }
  return namePath;
}

// 获取当前参数的全层级路径
function getParamPosition(fileStr: string, originParamPaths: string[]) {
  try {
    let paramPaths = [...originParamPaths];
    let currentLine = -1;
    let lastWord = "";
    let regexp = new RegExp(`\\W${paramPaths[0]}\\W`);
    const fileLines = fileStr.split("\n");
    while (paramPaths.length && currentLine < fileLines.length) {
      currentLine++;
      if (regexp.test(fileLines[currentLine])) {
        lastWord = paramPaths.shift() || "";
        regexp = new RegExp(`\\W${paramPaths[0]}\\W`);
      }
    }
    console.log("getParamPosition", currentLine, lastWord, paramPaths, originParamPaths, fileLines[currentLine]);
    // 还有路径没匹配完，证明未命中
    if (paramPaths.length) {
      return false;
    }
    return new Position(currentLine, fileLines[currentLine].indexOf(lastWord));
  } catch (error) {
    console.log(error);
  }
}

// 获取当前参数的全层级路径
function getParamPositionNew(fileStr: string, originParamPaths: string[]) {
  try {
    let paramPaths = originParamPaths.map((path) => ({ path, stackNum: 0 }));
    let currentLine = 1;
    let regexp = new RegExp(`\\W${paramPaths[0].path}\\W`);
    const shiftParamPaths: typeof paramPaths = [{ path: "_root", stackNum: 0 }]; // 被弹出的 param，当发现结构不符时，重新入栈
    const fileLines = fileStr.split("\n");
    let currentLineStr = fileLines[currentLine];
    while (paramPaths.length && currentLine < fileLines.length) {
      currentLineStr = fileLines[currentLine];
      const preParams = shiftParamPaths.slice(-1)[0];
      // console.log(currentLine, currentLineStr, preParams, JSON.stringify(paramPaths));
      if (preParams.stackNum === 0 && regexp.test(currentLineStr)) {
        shiftParamPaths.push(paramPaths.shift()!);
        regexp = new RegExp(`\\W${paramPaths[0]?.path}\\W`);
      } else if (currentLineStr.includes("{") && !currentLineStr.includes("}")) {
        preParams.stackNum++;
      } else if (currentLineStr.includes("}") && !currentLineStr.includes("{")) {
        preParams.stackNum--;
        if (preParams.stackNum < 0) {
          preParams.stackNum = 0;
          paramPaths.unshift(shiftParamPaths.pop()!);
          regexp = new RegExp(`\\W${paramPaths[0].path}\\W`);
        }
      }
      currentLine++;
    }
    const lastWord = shiftParamPaths.pop()?.path!;
    console.log("getParamPositionNew", currentLine, lastWord, paramPaths, originParamPaths, currentLineStr);
    // 还有路径没匹配完，证明未命中
    if (paramPaths.length) {
      return false;
    }
    return new Position(currentLine - 1, currentLineStr.indexOf(lastWord));
  } catch (error) {
    console.log(error);
  }
}

// 针对 locales 中 ts 翻译文件的跳转处理
function switchTsI18n(document: TextDocument, position: Position): any {
  const fileName = document.fileName; // 当前文件完整路径
  const word = document.getText(document.getWordRangeAtPosition(position)); // 当前光标所在单词
  const line = document.lineAt(position); // 当前光标所在行字符串

  // 如果非 src/locales 中的 ts 文件，则不做处理
  if (!fileName.includes("locales")) {
    console.log('fileName.includes("locales")');
    return;
  }

  const isZh = fileName.includes("zh-CN"); // 当前是否为中文字符串
  const targetFilePath = isZh ? fileName.replace("zh-CN", "en-US") : fileName.replace("en-US", "zh-CN");

  // 对应翻译文件不存在
  if (!fs.existsSync(targetFilePath)) {
    return;
  }
  const targetFileStr = fs.readFileSync(targetFilePath, "utf-8") as string;
  const namePath = getParamPaths(document, line, word); // 完整对象层级

  const targetPosition = getParamPositionNew(targetFileStr, namePath);
  if (!targetPosition) {
    window.showInformationMessage("未找到对应翻译");
    return;
  }

  return new Location(Uri.file(targetFilePath), targetPosition);
}

// 针对单文件翻译跳转
function switchJsonI18n(document: TextDocument, position: Position): any {
  const fileName = document.fileName; // 当前文件完整路径
  const word = document.getText(document.getWordRangeAtPosition(position)); // 当前光标所在单词
  const line = document.lineAt(position); // 当前光标所在行字符串

  // 如果非 .i18n.json 文件，则不做处理
  if (!fileName.includes(".i18n.json")) {
    return;
  }

  const namePath = getParamPaths(document, line, word); // 完整对象层级
  const targetFileStr = fs.readFileSync(fileName, "utf-8") as string;
  const isZh = namePath.includes('"zh-CN"'); // 当前是否为中文字符串
  namePath.shift();
  namePath.unshift(isZh ? '"en-US"' : '"zh-CN"');

  const targetPosition = getParamPositionNew(targetFileStr, namePath);
  if (!targetPosition) {
    window.showInformationMessage("未找到对应翻译");
    return;
  }

  return new Location(Uri.file(fileName), targetPosition);
}

// 针对跳转至具体的翻译
function jumpI18n(lang: "en" | "cn", textEditor: TextEditor, edit: TextEditorEdit): any {
  const { document } = textEditor;
  const fileName = document.fileName; // 当前文件完整路径
  const fileStr = fs.readFileSync(fileName, "utf-8") as string; // 文件文本
  const namePath = (document.getText(textEditor.selection) || "").split("."); // 当前选中翻译文本的路径
  let customI18nPath = (fileStr.match(/<i18n.+src="([^"]+)".+i18n>/) || [])[1]; // 获取 vue 注入的翻译文件

  // 存在翻译特别注入的翻译文件，则先从这里找，否则再从全局找
  if (customI18nPath) {
    const tempNamePath = [lang === "en" ? `"en-US"` : `"zh-CN"`, ...namePath.map((word) => `"${word}"`)];
    customI18nPath = path.resolve(path.dirname(fileName), customI18nPath);
    const customI18nStr = fs.readFileSync(customI18nPath, "utf-8") as string; // 文件文本
    const targetPosition = getParamPositionNew(customI18nStr, tempNamePath);
    if (targetPosition) {
      workspace.openTextDocument(Uri.file(customI18nPath)).then((document) => {
        window.showTextDocument(document, {
          selection: new Range(targetPosition, targetPosition),
        });
      });
      return;
    }
  }

  // 无特别注入的翻译，则从全局路径中找
  let globalI18nFilePath = path.resolve(fileName.split("src")[0], "src", "locales", lang === "en" ? "en-US" : "zh-CN", namePath.shift() + ".ts");
  if (!fs.existsSync(globalI18nFilePath)) {
    window.showInformationMessage("未找到对应翻译，选区是否正确");
    return;
  }
  const globalI18nStr = fs.readFileSync(globalI18nFilePath, "utf-8") as string; // 文件文本
  const targetPosition = getParamPositionNew(globalI18nStr, namePath);
  if (targetPosition) {
    workspace.openTextDocument(Uri.file(globalI18nFilePath)).then((document) => {
      window.showTextDocument(document, {
        selection: new Range(targetPosition, targetPosition),
      });
    });
    return;
  } else {
    window.showInformationMessage("未找到对应翻译，选区是否正确");
    return;
  }
}

// 跳转至 store 定义处
function jumpStore(textEditor: TextEditor, edit: TextEditorEdit): any {
  const { document } = textEditor;
  const fileName = document.fileName; // 当前文件完整路径
  const fileLines = fs.readFileSync(fileName, "utf-8").split("\n"); // 文件文本
  const lineNum = textEditor.selection.start.line; // 所在行数
  const lineStr = document.lineAt(lineNum).text; // 当前光标所在行字符串
  const targetKey = document.getText(textEditor.selection); // 当前选中文本
  const isMapField = !lineStr.includes("@"); // 有 @ 前缀，则证明是非 MapField，可能是 getter, mutation, action
  let isState = isMapField;
  let channel = ""; // 所属渠道
  let namespace: "root" | "index" | "ad" | "adset" | "campaign" = "root";

  // 根据路径找到当前渠道
  const channelNames = ["applovin", "facebook", "gdt", "google", "kuaishou", "mintegral", "tiktok", "multi", "toutiao", "unity"];
  for (let channelIndex = 0; channelIndex < channelNames.length; channelIndex++) {
    const channelName = channelNames[channelIndex];
    if (fileName.includes(channelName)) {
      channel = channelName;
      break;
    }
  }

  // 寻找对应 store 中的那个文件
  if (isMapField) {
    let currentLineNum = lineNum;
    while (currentLineNum >= 0) {
      if (fileLines[currentLineNum].includes("{")) {
        if (!fileLines[currentLineNum].includes("mapFields")) {
          currentLineNum = -1;
        } else {
          namespace = (fileLines[currentLineNum].split("/")[1] || "index`").split("'")[0].split("`")[0] as any;
        }
        break;
      }
      currentLineNum--;
    }
    if (currentLineNum < 0) {
      window.showInformationMessage("未找到对应 store，请选中 mapFields，Getter，mutation 或 action");
      return;
    }
  } else {
    const [namespaceStr] = lineStr.split(".");
    console.log("namespaceStr", namespaceStr, lineStr);
    if (lineStr.includes("State(")) {
      isState = true;
    }
    if (namespaceStr.includes("adCreate") || namespaceStr.includes("AdCreate")) {
      namespace = "index";
    } else if (namespaceStr.includes("adset")) {
      namespace = "adset";
    } else if (namespaceStr.includes("campaign")) {
      namespace = "campaign";
    } else if (namespaceStr.includes("ad")) {
      namespace = "ad";
    }
  }

  // 从文件中搜索关键字
  function searchKey(searchStr: string, targetFilePaths: string[]) {
    for (let pathIndex = 0; pathIndex < targetFilePaths.length; pathIndex++) {
      const targetFilePath = targetFilePaths[pathIndex];
      console.log(searchStr, targetFilePath);
      if (!fs.existsSync(targetFilePath)) {
        console.log(targetFilePath, "not exist");
        continue;
      }
      const targetFileLines = fs.readFileSync(targetFilePath, "utf-8").split("\n"); // 文件文本
      let currentLine = 0;
      while (currentLine < targetFileLines.length) {
        if (targetFileLines[currentLine].includes(searchStr)) {
          workspace.openTextDocument(Uri.file(targetFilePath)).then((document) => {
            const targetPosition = new Position(currentLine, targetFileLines[currentLine].indexOf(searchStr));
            window.showTextDocument(document, { selection: new Range(targetPosition, targetPosition) });
          });
          return true;
        }
        currentLine++;
      }
    }
    window.showInformationMessage("未找到对应 store，请选中 mapFields，Getter，mutation 或 action");
    return false;
  }
  console.log("namespace", namespace);

  // 遍历 dist 文件夹中的文件，获取文件相对路径
  function traverseFile(dirPath: string) {
    let urls: string[] = [];
    let files = fs.readdirSync(dirPath);
    for (let i = 0, length = files.length; i < length; i++) {
      let fileName = files[i];
      let fileExtName = fileName.split(".")[fileName.split(".").length - 1];
      let fileAbsolutePath = `${dirPath}/${fileName}`; // 文件绝对路径
      // 过滤 adsCreate 文件夹
      if (["adsCreate"].includes(fileExtName)) {
        continue;
      }
      let stats = fs.statSync(fileAbsolutePath);
      if (stats.isDirectory()) {
        urls = [...traverseFile(fileAbsolutePath), ...urls];
      } else {
        urls.push(fileAbsolutePath.substring(1)); // 去除首字母 '/'，避免 '//' 路径
      }
    }
    return urls;
  }

  const adsCreateStoreDir = path.resolve(fileName.split("src")[0], "src", "views", "adsCreate", "MixinsAdsCreate");
  const allStoreFiles = [
    ...traverseFile(path.resolve(fileName.split("src")[0], "src", "store")),
    path.resolve(path.resolve(adsCreateStoreDir, "StoreModuleMulti.ts")) as string,
    path.resolve(path.resolve(adsCreateStoreDir, "StoreDimensionModule.ts")) as string,
    path.resolve(path.resolve(adsCreateStoreDir, "StoreModule.ts")) as string,
    path.resolve(path.resolve(adsCreateStoreDir, "viewAdsCreateNew", "store", "storeModule.ts")) as string,
  ];

  // 如果是 store index 上的 store，则直接找 store/index.ts
  if (namespace === "root") {
    return searchKey(isState ? `${targetKey}:` : `${targetKey}(`, [path.resolve(fileName.split("src")[0], "src", "store", "index.ts"), ...allStoreFiles]);
  }

  // 如果是 createIndex 上的 store，则直接找 StoreDimensionModule.ts 和 StoreModuleMulti.ts
  if (namespace === "index") {
    return searchKey(isState ? `${targetKey}:` : `${targetKey}(`, allStoreFiles);
  }

  // 处理各渠道的 store
  const channelStoreDir = path.resolve(fileName.split("src")[0], "src", "store", "adsCreate", channel, namespace); // store 文件夹
  if (isState) {
    return searchKey(`${targetKey}:`, [path.resolve(channelStoreDir, "helper.ts"), path.resolve(channelStoreDir, "index.ts"), ...allStoreFiles]);
  } else {
    return searchKey(`${targetKey}(`, [path.resolve(channelStoreDir, "index.ts"), path.resolve(channelStoreDir, "helper.ts"), ...allStoreFiles]);
  }
}

// 搜索使用该翻译的地方
function searchI18n(textEditor: TextEditor, edit: TextEditorEdit): any {
  const { document } = textEditor;
  const fileName = document.fileName; // 当前文件完整路径
  const word = document.getText(textEditor.selection); // 当前光标所在单词
  const line = document.lineAt(textEditor.selection.start.line); // 当前光标所在行字符串
  const namePath = getParamPaths(document, line, word); // 完整对象层级
  if (fileName.includes(".i18n.json")) {
    namePath.shift();
  } else if (fileName.includes("locales")) {
    namePath.unshift(fileName.split("/").slice(-1)[0].split(".")[0]);
  } else if (fileName.includes("locales")) {
    namePath.length = 0;
    namePath.push(word);
  }

  // 直接从源码中查看配置
  // https://github.com/microsoft/vscode/blob/17de08a829e56657e44213a70cf69d18f06e74a5/src/vs/workbench/contrib/search/browser/searchActions.ts#L160-L188
  commands.executeCommand("workbench.action.findInFiles", {
    query: namePath.join(".").replace(/"/g, ""),
    filesToInclude: "./src",
    triggerSearch: true,
    matchWholeWord: true,
    isCaseSensitive: true,
  });
}

function setListen() {
  const port = 14301;

  http
    .createServer(function (request, response: any) {
      try {
        const { query } = url.parse(request.url as string);
        const { action, key } = querystring.parse(query as string);
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Methods", "PUT,POST,GET,DELETE,OPTIONS");
        if (action === "search") {
          commands.executeCommand("workbench.action.findInFiles", {
            query: key,
            filesToInclude: "./src",
            triggerSearch: true,
            matchWholeWord: true,
            isCaseSensitive: true,
          });
        } else {
          throw new Error("no such action");
        }
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("搜索成功，请查看 vscode");
      } catch (error) {
        response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("参数错误，请检查");
      }
    })
    .listen(port);
  console.log(`Server running at http://127.0.0.1:${port}/`);
}

// 插件被激活时所调用的函数，仅被激活时调用，仅进入一次
console.log("i18n-jump plugin read");
export function activate(context: ExtensionContext) {
  console.log("i18n-jump plugin activate");

  setListen();

  // 设置单词分隔
  languages.setLanguageConfiguration("typescript", {
    wordPattern: /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  // 设置单词分隔
  languages.setLanguageConfiguration("json", {
    wordPattern: /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  context.subscriptions.push(
    languages.registerDefinitionProvider(["typescript"], {
      provideDefinition: switchTsI18n,
    })
  );
  context.subscriptions.push(
    languages.registerDefinitionProvider(["json"], {
      provideDefinition: switchJsonI18n,
    })
  );

  context.subscriptions.push(
    commands.registerTextEditorCommand("i18n-jump.jump-i18n-cn", (textEditor: TextEditor, edit: TextEditorEdit) => jumpI18n("cn", textEditor, edit))
  );
  context.subscriptions.push(
    commands.registerTextEditorCommand("i18n-jump.jump-i18n-en", (textEditor: TextEditor, edit: TextEditorEdit) => jumpI18n("en", textEditor, edit))
  );
  context.subscriptions.push(commands.registerTextEditorCommand("i18n-jump.jump-store", jumpStore));
  context.subscriptions.push(commands.registerTextEditorCommand("i18n-jump.search-i18n", searchI18n));
}

export function deactivate() {}
