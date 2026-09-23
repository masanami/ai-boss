import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'env.dart';

// 項目 5: flutter_secure_storage（iOS は Keychain）に BYOK のキーを保存・読み出し。
const storage = FlutterSecureStorage();
const _key = 'anthropic-api-key';

Future<void> saveApiKey(String value) => storage.write(key: _key, value: value);
Future<String?> readApiKey() => storage.read(key: _key);

/// 自動検証用: SIMCTL_CHILD_ANTHROPIC_API_KEY で渡されたキーをキーチェーンへ移す（値は返さない）
Future<Map<String, Object?>> runKeychainCheck() async {
  final fromEnv = getEnv('ANTHROPIC_API_KEY');
  var bootstrapped = false;
  if (fromEnv != null && fromEnv.isNotEmpty) {
    await saveApiKey(fromEnv);
    bootstrapped = true;
  }
  final stored = await readApiKey();
  return {'ok': stored != null, 'bootstrappedFromEnvThisLaunch': bootstrapped, 'length': stored?.length ?? 0, 'looksLikeAnthropicKey': stored?.startsWith('sk-ant-') ?? false};
}
