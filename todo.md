<!-- 待完成 -->
- edit 跳转到
  - 寻找 helper 是否有值，没有则调整到 index，跳转到第一个 key
  - adCreateStore 跳转到 StoreModuleMulti
- action，mutation 跳转
  - 匹配 ad,adset,campaign 找到对应文件，adCreateStore 
  - 从 @adCreateStore 中找到赋值语句，解析具体的路径
  - 是否找到对应的 function，没找到则去父类 StoreDimensionModule 中找


<!-- 已完成 -->
- 点击$t跳转到翻译文件
- 在单翻译文件中，点击 key，定位切换中英文 key，
- 在多翻译文件中，点击 key，定位切换中英文 key，
- 反推，从具体文案，定位到代码，自动拼接字符串，输入到搜索栏中
