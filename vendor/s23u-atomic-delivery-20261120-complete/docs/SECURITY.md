# 权限与安全

当前 Debug 交付使用自定义 `dangerous` 权限：

```text
com.s23u.atomicservice.permission.BIND_ATOMIC_SERVICE
```

这是为了让不同签名的研发 APK 能在同一台测试手机上联调。安装客户端后，自动化脚本用 `pm grant` 授权。服务组件本身同时通过 `android:permission` 保护，未获授权的应用不能绑定。

生产交付建议改为以下之一：

1. 服务和获准应用使用同一证书，把权限改成 `signature`；或
2. 保留跨证书调用，但服务端增加调用方 UID/包名/签名证书白名单和审计日志。

不要把 Debug 权限策略直接作为公开量产方案。音频通过只读 `ParcelFileDescriptor` 传递，服务复制到自己的 cache，推理后删除临时副本；模型和数据库位于服务私有目录，普通应用无法直接读取。

