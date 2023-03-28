const path = require("path");
const fs = require("fs");
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
  languages,
  TextEditor,
  TextEditorEdit,
  ExtensionContext,
} from "vscode";

// 获取当前参数的全层级路径，
function getParamPaths(
  document: TextDocument,
  line: TextLine,
  firstWord: string
) {
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
    console.log(
      "getParamPosition",
      currentLine,
      lastWord,
      paramPaths,
      originParamPaths,
      fileLines[currentLine]
    );
    // 还有路径没匹配完，证明未命中
    if (paramPaths.length) {
      return false;
    }
    return new Position(currentLine, fileLines[currentLine].indexOf(lastWord));
  } catch (error) {
    console.log(error);
  }
}

// 针对 locales 中 ts 翻译文件的跳转处理
function jumpTsI18n(document: TextDocument, position: Position): any {
  const fileName = document.fileName; // 当前文件完整路径
  const word = document.getText(document.getWordRangeAtPosition(position)); // 当前光标所在单词
  const line = document.lineAt(position); // 当前光标所在行字符串

  // 如果非 src/locales 中的 ts 文件，则不做处理
  if (!fileName.includes("locales")) {
    console.log('fileName.includes("locales")');
    return;
  }

  const isZh = fileName.includes("zh-CN"); // 当前是否为中文字符串
  const targetFilePath = isZh
    ? fileName.replace("zh-CN", "en-US")
    : fileName.replace("en-US", "zh-CN");

  // 对应翻译文件不存在
  if (!fs.existsSync(targetFilePath)) {
    return;
  }
  const targetFileStr = fs.readFileSync(targetFilePath, "utf-8") as string;
  const namePath = getParamPaths(document, line, word); // 完整对象层级

  const targetPosition = getParamPosition(targetFileStr, namePath);
  if (!targetPosition) {
    window.showInformationMessage("未找到对应翻译");
    return;
  }

  return new Location(Uri.file(targetFilePath), targetPosition);
}

// 针对单文件翻译跳转
function jumpJsonI18n(document: TextDocument, position: Position): any {
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

  const targetPosition = getParamPosition(targetFileStr, namePath);
  if (!targetPosition) {
    window.showInformationMessage("未找到对应翻译");
    return;
  }

  return new Location(Uri.file(fileName), targetPosition);
}

// 针对 vue 文件跳转至具体的翻译
function jumpVueI18n(
  lang: "en" | "cn",
  textEditor: TextEditor,
): any {
  const { document } = textEditor;
  const fileName = document.fileName; // 当前文件完整路径
  const fileStr = fs.readFileSync(fileName, "utf-8") as string; // 文件文本
  const namePath = (document.getText(textEditor.selection) || "").split("."); // 当前选中翻译文本的路径
  let customI18nPath = (fileStr.match(/<i18n.+src="([^"]+)".+i18n>/) || [])[1]; // 获取 vue 注入的翻译文件

  // 存在翻译特别注入的翻译文件，则先从这里找，否则再从全局找
  if (customI18nPath) {
    const tempNamePath = [
      lang === "en" ? `"en-US"` : `"zh-CN"`,
      ...namePath.map((word) => `"${word}"`),
    ];
    customI18nPath = path.resolve(path.dirname(fileName), customI18nPath);
    const customI18nStr = fs.readFileSync(customI18nPath, "utf-8") as string; // 文件文本
    const targetPosition = getParamPosition(customI18nStr, tempNamePath);
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
  let globalI18nFilePath = path.resolve(
    fileName.split("src")[0],
    "src",
    "locales",
    lang === "en" ? "en-US" : "zh-CN",
    namePath.shift() + ".ts"
  );
  const globalI18nStr = fs.readFileSync(globalI18nFilePath, "utf-8") as string; // 文件文本
  const targetPosition = getParamPosition(globalI18nStr, namePath);
  if (targetPosition) {
    workspace
      .openTextDocument(Uri.file(globalI18nFilePath))
      .then((document) => {
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

// 插件被激活时所调用的函数，仅被激活时调用，仅进入一次
console.log("i18n-jump plugin read");
export function activate(context: ExtensionContext) {
  console.log("i18n-jump plugin activate");

  // 设置单词分隔
  languages.setLanguageConfiguration("typescript", {
    wordPattern:
      /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  // 设置单词分隔
  languages.setLanguageConfiguration("json", {
    wordPattern:
      /([^\`\~\!\@\$\^\&\*\(\)\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\s]+)/g,
  });

  context.subscriptions.push(
    languages.registerDefinitionProvider(["typescript"], {
      provideDefinition: jumpTsI18n,
    })
  );
  context.subscriptions.push(
    languages.registerDefinitionProvider(["json"], {
      provideDefinition: jumpJsonI18n,
    })
  );

  context.subscriptions.push(
    commands.registerTextEditorCommand(
      "i18n-jump.vue-jump-cn",
      (textEditor: TextEditor, edit: TextEditorEdit) =>
        jumpVueI18n("cn", textEditor, edit)
    )
  );
  context.subscriptions.push(
    commands.registerTextEditorCommand(
      "i18n-jump.vue-jump-en",
      (textEditor: TextEditor, edit: TextEditorEdit) =>
        jumpVueI18n("en", textEditor, edit)
    )
  );
  context.subscriptions.push(
    commands.registerTextEditorCommand("i18n-jump.i18n-jump-code", searchI18n)
  );
}

export function deactivate() {}
