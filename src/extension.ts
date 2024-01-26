import * as path from "path";
import * as fs from "fs";
import * as url from "url";
import * as http from "http";
import { Server } from "http";
import * as querystring from "querystring";
import { set, get, forIn, isObject } from "lodash";
import { spawn } from "child_process";
import {
  TextDocument,
  TextLine,
  Position,
  Location,
  Uri,
  env,
  Range,
  window,
  workspace,
  commands,
  languages,
  TextEditor,
  TextEditorEdit,
  ExtensionContext,
  CompletionItem,
  CompletionItemKind,
} from "vscode";

const oldProjectName = "xmp_fe";
const newProjectName = "xmp_fe_kayn";
const baseLang = "zh-CN";
const vsLog = window.createOutputChannel("i18n-jump");
let server: null | Server = null;
let isNewProject = false;
let isEnableConfigJump = false; // 是否启用配置化关联文件跳转
let projectPath = "";
let globalI18nPath = "";
let targetLanguages: string[] = [];
let channels: string[] = [];

function myLog(fun: 'log' | 'warn' | 'error' | 'info', ...text: any[]) {
  console[fun](...text);
  vsLog.appendLine(text.join('  '));
};

// 获取对象的 key path
function getValue2KeyPathMapFromObject(currentObj: Object, originObj?: Object, prefix = "", keyPath2ValueMap: { [keyPath: string]: string } = {}) {
  originObj = originObj || currentObj;
  forIn(currentObj, (value, key) => {
    const path = prefix ? prefix + "." + key : key;
    if (isObject(value)) {
      getValue2KeyPathMapFromObject(value, originObj, path, keyPath2ValueMap);
    } else {
      keyPath2ValueMap[get(originObj, path, "").replace(/[^\u4e00-\u9fa5]/g, "")] = path;
    }
  });
  return keyPath2ValueMap;
}

// 搜索特定文件是否存在某字符串，如果存在，则返回所在行，所在列
function findFileStr(filePath: string, regStr: string, flag = "gi") {
  let fileStr = fs.readFileSync(filePath, "utf8");
  const [searchStrIndex] = [...fileStr.matchAll(new RegExp(regStr, flag))].map((match) => match.index);
  if (searchStrIndex === undefined) {
    return null;
  }

  return {
    row: (fileStr.substring(0, searchStrIndex).match(/\n/g) || []).length,
    column: searchStrIndex - fileStr.lastIndexOf("\n", searchStrIndex) - 1,
  };
}

// 深度遍历，获取所有符合规则的文件
function findTargetFiles(dir: string, prefix: string) {
  const files = fs.readdirSync(dir);
  const targetFiles: string[] = [];

  files.forEach((file) => {
    const pathname = `${dir}/${file}`;
    const stat = fs.statSync(pathname);
    if (stat && stat.isDirectory()) {
      targetFiles.push(...findTargetFiles(pathname, prefix));
    } else if (pathname.endsWith(prefix)) {
      targetFiles.push(pathname);
    }
  });

  return targetFiles;
}

// 【】获取系统存在的语言
function updateLanguage() {
  isEnableConfigJump = workspace.getConfiguration("i18n-jump").get("showConfigJump") as boolean;
  projectPath = workspace.workspaceFolders![0].uri.fsPath.split("src")[0];
  globalI18nPath = path.resolve(projectPath, "src/locales/");
  if (projectPath.includes(newProjectName)) {
    isNewProject = true;
    globalI18nPath = `${projectPath}/locales`;
  }

  targetLanguages = fs
    .readdirSync(globalI18nPath, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name);
  // myLog('log', "projectPath", projectPath);
  // myLog('log', "channels", channels);
  // myLog('log', "targetLanguages", targetLanguages);
}

// 获取当前渠道，路径已发生变化，路径不可用
function getChannel(filePath: string) {
  channels = findTargetFiles(path.resolve(projectPath, `src/views/ads-manager/create/rules/modules`), "ts").map((path) => path.split("/").pop()!.split(".")[0]);
  return channels.find((channel) => filePath.includes(channel));
}

// 【】获取轮询的下一个语义
function getNextLanguage(path: string) {
  const originLang = targetLanguages.find((lang) => path.indexOf(lang) > -1)!; // 匹配当前语言
  const nextLanguage = [...targetLanguages, ...targetLanguages][targetLanguages.indexOf(originLang) + 1]; // 获取下一个语言
  return path.replace(originLang, nextLanguage);
}

// 【】获取当前参数的全层级路径
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
        namePath.unshift(
          currentLine
            .split(":")[0]
            .trim()
            .replace(/^"(.*)"$/, "$1")
        );
      } else {
        stackNum--;
      }
    } else if (currentLine.includes("}")) {
      stackNum++;
    }
  }
  return namePath;
}

// 【】获取当前参数的全层级路径
function getParamPosition(fileStr: string, originParamPaths: string[]) {
  try {
    let paramPaths = originParamPaths.map((path) => ({ path, stackNum: 0 }));
    let currentLine = 1;
    let regexp = new RegExp(`["' ]${paramPaths[0].path}\\W`);
    const shiftParamPaths: typeof paramPaths = [{ path: "_root", stackNum: 0 }]; // 被弹出的 param，当发现结构不符时，重新入栈
    const fileLines = fileStr.split("\n");
    let currentLineStr = fileLines[currentLine];
    while (paramPaths.length && currentLine < fileLines.length) {
      currentLineStr = fileLines[currentLine];
      const preParams = shiftParamPaths.slice(-1)[0];
      if (!preParams) {
        break;
      }
      // myLog('log', currentLine, currentLineStr, preParams, JSON.stringify(paramPaths));
      if (preParams.stackNum === 0 && regexp.test(currentLineStr)) {
        shiftParamPaths.push(paramPaths.shift()!);
        regexp = new RegExp(`["' ]${paramPaths[0]?.path}\\W`);
      } else if (currentLineStr.includes("{") && !currentLineStr.includes("}")) {
        preParams.stackNum++;
      } else if (currentLineStr.includes("}") && !currentLineStr.includes("{")) {
        preParams.stackNum--;
        if (preParams.stackNum < 0) {
          preParams.stackNum = 0;
          paramPaths.unshift(shiftParamPaths.pop()!);
          regexp = new RegExp(`["' ]${paramPaths[0].path}\\W`);
        }
      }
      currentLine++;
    }
    const lastWord = shiftParamPaths.pop()?.path!;
    myLog('log', "getParamPosition", currentLine, lastWord, paramPaths, originParamPaths, currentLineStr);
    // 还有路径没匹配完，证明未命中
    if (paramPaths.length) {
      return false;
    }
    return new Position(currentLine - 1, currentLineStr.indexOf(lastWord));
  } catch (error) {
    myLog('log', error);
  }
}

// 【】往特定层级中，添加新的 key
function addNewKey(paramPaths: string[], targetFilePaths: string[], isGlobalLocale: boolean) {
  targetFilePaths.forEach((targetFilePath) => {
    let fileStr = fs.readFileSync(targetFilePath, "utf-8") as string; // 文件文本
    let jsonObj = JSON.parse(fileStr);
    try {
      if (isGlobalLocale) {
        set(jsonObj, paramPaths.join("."), get(jsonObj, paramPaths.join(".")) || "");
      } else {
        targetLanguages.forEach((language) => {
          set(jsonObj, [language, ...paramPaths].join("."), get(jsonObj, [language, ...paramPaths].join(".")) || "");
        });
      }
      fs.writeFileSync(targetFilePath, JSON.stringify(jsonObj, null, isNewProject ? 2 : 4) + "\n", "utf-8"); // 文件文本
    } catch (error) {
      myLog('log', "addNewKey", error);
    }
  });
}

// 【】针对单文件翻译跳转
function switchJsonI18n(document: TextDocument, position: Position): any {
  updateLanguage();
  let fileName = document.fileName; // 当前文件完整路径
  const word = document.getText(document.getWordRangeAtPosition(position)); // 当前光标所在单词
  const line = document.lineAt(position); // 当前光标所在行字符串
  const isLocales = fileName.includes("locales");
  if (line.text.indexOf(word) > line.text.indexOf(":")) {
    return;
  }

  // 如果非 .i18n.json 文件，则不做处理
  if (!fileName.includes("i18n.json") && !fileName.includes(globalI18nPath)) {
    return;
  }

  let namePath: string[] = getParamPaths(document, line, word); // 完整对象层级;
  let targetFileStr = "";

  // 响应翻译文件变化，实现 locales 全局文件夹中的跳转
  if (isLocales) {
    fileName = getNextLanguage(fileName);
    targetFileStr = fs.readFileSync(fileName, "utf-8") as string;
  } else {
    targetFileStr = fs.readFileSync(fileName, "utf-8") as string;
    namePath.unshift(getNextLanguage(namePath.shift()!));
  }

  let targetPosition = getParamPosition(targetFileStr, namePath);
  if (!targetPosition) {
    if (isLocales) {
      addNewKey(namePath, [fileName], true);
    } else {
      addNewKey(namePath.slice(1), [fileName], false);
    }
  }
  targetPosition = getParamPosition(targetFileStr, namePath);
  return new Location(Uri.file(fileName), targetPosition as Position);
}

// ts 文件定义跳转
function typescriptDefinition(document: TextDocument, position: Position): any {
  const locations: Location[] = [];
  const componentLocation = jumpComponent(document, position);
  if (componentLocation) {
    locations.push(componentLocation);
  }
  locations.push(...jumpConfig(document, position));
  return locations;
}

// 配置化项目，跳转到组件
function jumpComponent(document: TextDocument, position: Position): any {
  updateLanguage();
  if (!isNewProject) {
    return;
  }
  let componentName = document
    .getText(document.getWordRangeAtPosition(position))
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase(); // 当前光标所在单词
  componentName = componentName.startsWith("-") ? componentName.substring(1) : componentName;

  // 遍历  文件夹中的文件，获取文件相对路径
  function traverseFile(dirPath: string) {
    let urls: string[] = [];
    let files = fs.readdirSync(dirPath);
    for (let i = 0, length = files.length; i < length; i++) {
      let fileName = files[i];
      let fileAbsolutePath = `${dirPath}/${fileName}`; // 文件绝对路径
      let stats = fs.statSync(fileAbsolutePath);
      if (stats.isDirectory()) {
        urls = [...traverseFile(fileAbsolutePath), ...urls];
      } else {
        urls.push(fileAbsolutePath.substring(1)); // 去除首字母 '/'，避免 '//' 路径
      }
    }
    return urls;
  }
  const componentDirPath = path.resolve(workspace.workspaceFolders![0].uri.fsPath.split("src")[0], "src/components");
  const componentPaths = traverseFile(componentDirPath).filter((item) => item.includes(`/${componentName}/`));
  if (!componentPaths.length) {
    return;
  }
  let targetFilePath = componentPaths.find((item) => item.includes("index.vue")) || componentPaths[0];
  const definitionUri = Uri.file(targetFilePath);
  return new Location(definitionUri, new Position(0, 0));
}

// vue 文件定义跳转
function vueDefinition(document: TextDocument, position: Position): any {
  const locations: Location[] = [];
  updateLanguage();
  const business2CLocation = jumpBusiness2C(document, position);
  if (business2CLocation) {
    locations.push(business2CLocation);
  }
  locations.push(...jumpConfig(document, position));
  return locations;
}

// 从 Business 与 C 组件之间快速相互跳转
function jumpBusiness2C(document: TextDocument, position: Position): any {
  updateLanguage();
  if (!isNewProject) {
    return;
  }
  let fileName = document.fileName; // 当前文件完整路径
  let componentName = document
    .getText(document.getWordRangeAtPosition(position))
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase(); // 当前光标所在单词
  componentName = componentName.startsWith("-") ? componentName.substring(1) : componentName;
  if (!fileName.includes(`/${componentName}/`)) {
    return;
  }
  const componentNameParams = componentName.split("-");
  const targetComponentNameParams = [...componentNameParams];
  targetComponentNameParams[0] = componentNameParams[0] === "c" ? "business" : "c";
  const targetComponentName = targetComponentNameParams.join("-");

  // 遍历  文件夹中的文件，获取文件相对路径
  function traverseFile(dirPath: string) {
    let urls: string[] = [];
    let files = fs.readdirSync(dirPath);
    for (let i = 0, length = files.length; i < length; i++) {
      let fileName = files[i];
      let fileAbsolutePath = `${dirPath}/${fileName}`; // 文件绝对路径
      let stats = fs.statSync(fileAbsolutePath);
      if (stats.isDirectory()) {
        urls = [...traverseFile(fileAbsolutePath), ...urls];
      } else {
        urls.push(fileAbsolutePath.substring(1)); // 去除首字母 '/'，避免 '//' 路径
      }
    }
    return urls;
  }
  const componentDirPath = path.resolve(workspace.workspaceFolders![0].uri.fsPath.split("src")[0], "src/components");
  const componentPaths = traverseFile(componentDirPath).filter((item) => item.includes(`/${targetComponentName}/`));
  if (!componentPaths.length) {
    return;
  }
  let targetFilePath = componentPaths.find((item) => item.includes("index.vue")) || componentPaths[0];
  const definitionUri = Uri.file(targetFilePath);
  return new Location(definitionUri, new Position(0, 0));
}

// 根据草稿字段，跳转到相关配置，如「校验」「草稿定义」「被动联动」
function jumpConfig(document: TextDocument, position: Position) {
  updateLanguage();
  if (!isEnableConfigJump || !isNewProject) {
    return [];
  }

  let currentFilePath = document.fileName; // 当前文件完整路径
  const word = document.getText(document.getWordRangeAtPosition(position)); // 当前光标所在单词
  const channel = getChannel(currentFilePath);
  myLog('log', "word", word);

  const checkConfigs: {
    filePath: string;
    searchStr: string;
  }[] = [];

  // 搜索校验
  checkConfigs.push({
    filePath: path.resolve(projectPath, `src/views/ads-manager/create/rules/modules/${channel}.ts`),
    searchStr: `${word}\\(`,
  });
  checkConfigs.push({
    filePath: path.resolve(projectPath, `src/views/ads-manager/create/rules/modules/${channel}.ts`),
    searchStr: `${word.toUpperCase()}\]`,
  });

  // 搜索草稿定义
  checkConfigs.push({
    filePath: path.resolve(projectPath, `src/types/${channel}.ts`),
    searchStr: `${word}: `,
  });

  // 搜索被动联动
  findTargetFiles(path.resolve(projectPath, `src/views/ads-manager/create/fields-trigger/modules/${channel}`), ".ts").forEach((filePath) => {
    checkConfigs.push({
      filePath: filePath,
      searchStr: word,
    });
  });

  // 搜索配置项
  findTargetFiles(path.resolve(projectPath, `src/views/ads-manager/create/media-platform-config/modules/${channel}`), ".ts").forEach((filePath) => {
    checkConfigs.push({
      filePath: filePath,
      searchStr: `${word}: \\{`,
    });
  });

  return (
    checkConfigs
      // .filter((conf) => conf.filePath !== currentFilePath)
      .map((conf) => ({
        conf,
        position: findFileStr(conf.filePath, conf.searchStr),
      }))
      .filter((result) => result.position)
      .map((result) => new Location(Uri.file(result.conf.filePath), new Position(result.position!.row, result.position!.column)))
  );
}

// 【】针对跳转至具体的翻译
function jumpI18n(lang: "en" | "cn", textEditor: TextEditor, edit: TextEditorEdit): any {
  updateLanguage();
  const { document } = textEditor;
  const fileName = document.fileName; // 当前文件完整路径
  const fileStr = fs.readFileSync(fileName, "utf-8") as string; // 文件文本
  const namePath = (document.getText(textEditor.selection) || "").split("."); // 当前选中翻译文本的路径
  let customI18nPath = (fileStr.match(/<i18n.+src="([^"]+)".+i18n>/) || [])[1]; // 获取 vue 注入的翻译文件

  let globalI18nFilePath = path.resolve(globalI18nPath, lang === "en" ? "en-US" : "zh-CN", "index.i18n.json");
  if (isNewProject) {
    globalI18nFilePath = path.resolve(globalI18nPath, lang === "en" ? "en-US" : "zh-CN", `${namePath.shift()}.json`);
  }

  function findPosition() {
    // 存在翻译特别注入的翻译文件，则先从这里找，否则再从全局找
    if (customI18nPath) {
      const tempNamePath = [lang === "en" ? `"en-US"` : `"zh-CN"`, ...namePath.map((word) => `"${word}"`)];
      if (customI18nPath.includes("@")) {
        customI18nPath = customI18nPath.replace("@/", "");
        customI18nPath = path.resolve(fileName.split("src")[0], "src", customI18nPath);
      } else {
        customI18nPath = path.resolve(path.dirname(fileName), customI18nPath);
      }
      const customI18nStr = fs.readFileSync(customI18nPath, "utf-8") as string; // 文件文本
      const targetPosition = getParamPosition(customI18nStr, tempNamePath);
      if (targetPosition) {
        const selection = new Range(targetPosition, targetPosition);
        const openedEditor = window.visibleTextEditors.find((e) => e.document.fileName === customI18nPath);
        if (openedEditor) {
          window.showTextDocument(openedEditor.document, {
            selection,
            viewColumn: openedEditor.viewColumn,
          });
        } else {
          workspace.openTextDocument(Uri.file(customI18nPath)).then((document) => {
            window.showTextDocument(document, {
              selection,
            });
          });
        }
        return true;
      }
    }

    // 无特别注入的翻译，则从全局路径中找
    if (fs.existsSync(globalI18nFilePath)) {
      const globalI18nStr = fs.readFileSync(globalI18nFilePath, "utf-8") as string; // 文件文本
      const targetPosition = getParamPosition(globalI18nStr, namePath);
      if (targetPosition) {
        const selection = new Range(targetPosition, targetPosition);
        const openedEditor = window.visibleTextEditors.find((e) => e.document.fileName === globalI18nFilePath);
        if (openedEditor) {
          window.showTextDocument(openedEditor.document, {
            selection,
            viewColumn: openedEditor.viewColumn,
          });
        } else {
          workspace.openTextDocument(Uri.file(globalI18nFilePath)).then((document) => {
            window.showTextDocument(document, {
              selection,
            });
          });
        }
        return true;
      }
    }
  }

  if (findPosition()) {
    return;
  } else if (customI18nPath) {
    addNewKey(namePath, [customI18nPath], false);
    findPosition();
  } else if (fs.existsSync(globalI18nFilePath)) {
    const originLang = targetLanguages.find((lang) => globalI18nFilePath.indexOf(lang) > -1)!; // 匹配当前语言
    addNewKey(
      namePath,
      targetLanguages.map((lan) => globalI18nFilePath.replace(originLang, lan)),
      true
    );
    findPosition();
  } else {
    window.showErrorMessage("未找到对应翻译，选区是否正确");
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
  const channelNames: string[] = [];
  const channelStoreDirPath = path.resolve(fileName.split("src")[0], "src", "store", "adsCreate"); // store 文件夹
  const files = fs.readdirSync(channelStoreDirPath);
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(channelStoreDirPath, files[i]);
    const fileStat = fs.statSync(filePath);
    if (fileStat.isDirectory()) {
      channelNames.push(files[i]);
    }
  }

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
      window.showErrorMessage("未找到对应 store，请选中 mapFields，Getter，mutation 或 action");
      return;
    }
  } else {
    const [namespaceStr] = lineStr.split(".");
    myLog('log', "namespaceStr", namespaceStr, lineStr);
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
      myLog('log', searchStr, targetFilePath);
      if (!fs.existsSync(targetFilePath)) {
        myLog('log', targetFilePath, "not exist");
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
    window.showErrorMessage("未找到对应 store，请选中 mapFields，Getter，mutation 或 action");
    return false;
  }
  myLog('log', "namespace", namespace);

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

// 【】跳转到 gitlab 页面
function jumpGit(uri: Uri) {
  const workspaceFolders = workspace.workspaceFolders;
  const gitDirPath = path.join(workspaceFolders![0].uri.fsPath, ".git");
  const configPath = path.join(gitDirPath, "config");

  fs.readFile(configPath, "utf8", (err: any, data: string) => {
    const isGitlab = data.includes("git@gitlab");
    const match = data.match(/url\s*=\s*(.*)/);
    if (match) {
      const branch = data.includes("refs/heads/master") ? "master" : "main";
      const remoteUrl = match[1];
      const matchParams = remoteUrl.match(/([^/@]+)@([^:/]+):(.+)\.git$/);
      if (matchParams) {
        const hostname = matchParams[2];
        const path = matchParams[3];
        env.openExternal(Uri.parse(`https://${hostname}/${path}/${isGitlab ? "-/" : ""}blob/${branch}${uri.path.split(workspace.rootPath!)[1]}`));
      }
    }
  });
}

// i18n 代码补全
function provideI18n(document: TextDocument, position: Position) {
  updateLanguage();
  if (!isNewProject) {
    return [];
  }

  let pathStr = document.lineAt(position).text.substring(0, position.character);
  if (!/\Wt\(['"`]/.test(pathStr)) {
    return [];
  }
  pathStr = pathStr.split("t(")[1].substring(1);

  const fileName = pathStr.split(".")[0].trim();
  myLog('log', "fileName", fileName);

  // 文件的选择
  if (!pathStr.includes(".")) {
    return findTargetFiles(path.resolve(globalI18nPath, "zh-CN"), "json").map(
      (targetFile) => new CompletionItem(path.basename(targetFile).replace(".json", ""), CompletionItemKind.Field)
    );
  }

  // 添加不同颜色
  window.activeTextEditor!.setDecorations(
    window.createTextEditorDecorationType({
      fontWeight: "bold",
    }),
    [new Range(position, position)]
  );

  // 文件内容的字段选择
  const jsonObj = require(path.resolve(globalI18nPath, "zh-CN", `${fileName}.json`));
  const levelPath = pathStr
    .split(".")
    .slice(1)
    .filter((param) => param)
    .join(".");
  const currentLevelObj = levelPath ? get(jsonObj, levelPath) : jsonObj;
  if (!isObject(currentLevelObj)) {
    return [];
  }

  return Object.keys(currentLevelObj).map((key) => {
    return new CompletionItem(key, CompletionItemKind.Field);
  });
}

// 【】搜索使用该翻译的地方
function searchI18n(textEditor: TextEditor, edit: TextEditorEdit): any {
  updateLanguage();
  const { document } = textEditor;
  const word = document.getText(textEditor.selection); // 当前光标所在单词
  const line = document.lineAt(textEditor.selection.start.line); // 当前光标所在行字符串
  const namePath = getParamPaths(document, line, word); // 完整对象层级
  if (targetLanguages.includes(namePath[0])) {
    namePath.shift();
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

// i18n 翻译，利用项目中的 I18nCreator.js 脚本
function i18nTranslate(uri: Uri) {
  const stat = fs.statSync(uri.path);
  const targetFilePaths = [];
  if (stat && stat.isDirectory()) {
    targetFilePaths.push(...findTargetFiles(uri.path, ".json"));
  } else if (uri.path.includes(".json")) {
    targetFilePaths.push(uri.path);
  }
  if (!targetFilePaths.length) {
    window.showErrorMessage("未找到翻译文件，请重新选择文件");
    return;
  }
  updateLanguage();
  myLog('log', "targetFilePaths ", targetFilePaths);
  myLog('log', "node", `${projectPath}/scripts/I18nCreator.js`, ...targetFilePaths);
  const childProcess = spawn("node", [`${projectPath}/scripts/I18nCreator.cjs`, ...targetFilePaths], { cwd: projectPath });
  childProcess.stdout.on("data", (data) => {
    myLog('log', `I18nCreator: ${data}`);
  });
  childProcess.stderr.on("data", (data) => {
    window.showErrorMessage("翻译异常，请联系静文", '查看运行日志').then(selection => {
      if (selection === '查看运行日志') {
        vsLog.show();
      }
    });
    myLog('error', `I18nCreator: ${data}`);
  });
  childProcess.on("close", (code) => {
    if (code === 0) {
      window.showInformationMessage("翻译成功，请查看 git 对比");
    }
  });
}

// 端口监听，启动 node 服务，监听请求
function setListen() {
  const port = 14301;

  server = http
    .createServer(function (request, response: any) {
      try {
        updateLanguage();
        const { query } = url.parse(request.url as string);
        const { action, key } = querystring.parse(query as string);
        response.setHeader("Access-Control-Max-Age", "18000");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-headers", "*");
        response.setHeader("Access-Control-Allow-Methods", "*");
        myLog('log', "request.method", request.method);

        if (request.method === "OPTIONS") {
          response.writeHead(200);
          response.end();
          return;
        }

        if (request.method === "GET") {
          if (action === "search") {
            commands.executeCommand("workbench.action.findInFiles", {
              query: key,
              filesToInclude: "./src",
              triggerSearch: true,
              matchWholeWord: true,
              isCaseSensitive: true,
            });
            // 直接定位翻译文件
            const keyParams = (Array.isArray(key) ? key![0] : key || "")?.split(".");
            let globalI18nFilePath = path.resolve(globalI18nPath, "zh-CN", "index.i18n.json");
            if (isNewProject) {
              globalI18nFilePath = path.resolve(globalI18nPath, "zh-CN", `${keyParams.shift()}.json`);
            }
            const globalI18nStr = fs.readFileSync(globalI18nFilePath, "utf-8") as string; // 文件文本
            const targetPosition = getParamPosition(globalI18nStr, keyParams);
            if (targetPosition) {
              const selection = new Range(targetPosition, targetPosition);
              const openedEditor = window.visibleTextEditors.find((e) => e.document.fileName === globalI18nFilePath);
              if (openedEditor) {
                window.showTextDocument(openedEditor.document, {
                  selection,
                  viewColumn: openedEditor.viewColumn,
                });
              } else {
                workspace.openTextDocument(Uri.file(globalI18nFilePath)).then((document) => {
                  window.showTextDocument(document, {
                    selection,
                  });
                });
              }
              return true;
            }
          }
          response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("操作成功，请查看 vscode");
          return;
        }

        if (request.method === "POST") {
          let body = "";

          request.on("data", (chunk) => {
            body += chunk;
          });

          request.on("end", () => {
            try {
              if (action === "i18n") {
                const textRows = JSON.parse(body as string).textRows;
                const openedEditor = window.visibleTextEditors.find((e) => e.document.fileName.includes(".json"));
                const fileName = openedEditor?.document.fileName || "";
                myLog('log', "i18n", fileName, textRows);
                if (!openedEditor) {
                } else if (fileName.includes(globalI18nPath)) {
                  myLog('log', "全局配置的多语言");
                  const targetObj = JSON.parse(fs.readFileSync(fileName, "utf-8") as string);
                  const baseLangValue2KeyPathMap = getValue2KeyPathMapFromObject(targetObj);
                  const targetLangObjs = targetLanguages
                    .filter((lang) => lang !== baseLang)
                    .map((lang) => ({
                      lang,
                      fileName: fileName.replace(baseLang, lang),
                      obj: JSON.parse(fs.readFileSync(fileName.replace(baseLang, lang), "utf-8") as string),
                    }));
                  textRows.forEach((row: { [langKey: string]: string }) => {
                    const keyPath = baseLangValue2KeyPathMap[(row[baseLang] || "").replace(/[^\u4e00-\u9fa5]/g, "")];
                    if (keyPath) {
                      targetLangObjs.forEach((langObj) => {
                        row[langObj.lang] && set(langObj.obj, keyPath, row[langObj.lang]);
                      });
                    }
                  });
                  targetLangObjs.forEach((langObj) =>
                    fs.writeFileSync(langObj.fileName, JSON.stringify(langObj.obj, null, isNewProject ? 2 : 4) + "\n", "utf-8")
                  );
                } else {
                  myLog('log', "单翻译文件");
                  const targetObj = JSON.parse(fs.readFileSync(fileName, "utf-8") as string);
                  const baseLangValue2KeyPathMap = getValue2KeyPathMapFromObject(targetObj[baseLang]);
                  textRows.forEach((row: { [langKey: string]: string }) => {
                    const keyPath = baseLangValue2KeyPathMap[(row[baseLang] || "").replace(/[^\u4e00-\u9fa5]/g, "")];
                    if (keyPath) {
                      targetLanguages.forEach((lang) => {
                        row[lang] && set(targetObj, `${lang}.${keyPath}`, row[lang]);
                      });
                    }
                  });
                  fs.writeFileSync(fileName, JSON.stringify(targetObj, null, isNewProject ? 2 : 4) + "\n", "utf-8"); // 文件文本
                }
                response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
                response.end("操作成功，请查看 vscode");
              }
            } catch (error) {
              myLog('log', error);
              response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
              response.end("参数错误，请检查" + (error || "").toString());
            }
          });
        }
      } catch (error) {
        myLog('log', error);
        response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("参数错误，请检查");
      }
    });
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      myLog('error', `Port ${port} is already in use`);
      server?.close();
      server = null;
    }
  });
  server.listen(port, () => {
    myLog('log', `Server running at http://127.0.0.1:${port}/`);
  });
}

// 关闭监听
function stopListen() {
  server?.close();
  server = null;
  myLog('log', 'Server stop');
}

// 检查当前项目是否监听成功
function checkListen() {
  if (server) {
    window.showInformationMessage('端口监听中');
  } else {
    window.showInformationMessage('端口未监听');
  }
}

// 插件被激活时所调用的函数，仅被激活时调用，仅进入一次
myLog('log', "i18n-jump plugin read");
export function activate(context: ExtensionContext) {
  myLog('log', "i18n-jump plugin activate");

  if (workspace.workspaceFolders![0].uri.fsPath.includes(oldProjectName)) {
    setListen();
  }

  // 设置单词分隔
  languages.setLanguageConfiguration("typescript", {
    wordPattern: /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  // 设置单词分隔
  languages.setLanguageConfiguration("json", {
    wordPattern: /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  // 设置 JSON 定义跳转
  context.subscriptions.push(
    languages.registerDefinitionProvider(["json"], {
      provideDefinition: switchJsonI18n,
    })
  );
  // 设置配置化项目，跳转至组件功能
  context.subscriptions.push(
    languages.registerDefinitionProvider(["typescript"], {
      provideDefinition: typescriptDefinition,
    })
  );
  // 设置配置化项目，从 Business 与 C 组件之间快速相互跳转
  context.subscriptions.push(
    languages.registerDefinitionProvider(["vue"], {
      provideDefinition: vueDefinition,
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
  context.subscriptions.push(commands.registerCommand("i18n-jump.jump-git", jumpGit));
  context.subscriptions.push(commands.registerCommand("i18n-jump.i18n-translate", i18nTranslate));
  context.subscriptions.push(commands.registerCommand("i18n-jump.start-server", setListen));
  context.subscriptions.push(commands.registerCommand("i18n-jump.stop-server", stopListen));
  context.subscriptions.push(commands.registerCommand("i18n-jump.check-server", checkListen));
  // 添加翻译代码补全
  // context.subscriptions.push(languages.registerCompletionItemProvider(["javascript", "typescript", "vue"], { provideCompletionItems: provideI18n }, "."));
}

export function deactivate() { }
