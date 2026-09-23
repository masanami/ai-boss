import 'dart:ffi';
import 'package:ffi/ffi.dart';

// iOS の Flutter では Platform.environment に SIMCTL_CHILD_* で渡した変数が現れなかった（実測）。
// libc の getenv を直接呼んで読む（自動検証専用）。
final _getenv = DynamicLibrary.process().lookupFunction<Pointer<Utf8> Function(Pointer<Utf8>), Pointer<Utf8> Function(Pointer<Utf8>)>('getenv');

String? getEnv(String name) {
  final key = name.toNativeUtf8();
  try {
    final value = _getenv(key);
    return value == nullptr ? null : value.toDartString();
  } finally {
    malloc.free(key);
  }
}
