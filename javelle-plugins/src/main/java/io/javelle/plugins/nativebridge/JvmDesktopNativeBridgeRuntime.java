package io.javelle.plugins.nativebridge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse.BodyHandlers;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Native bridge runtime for pure JVM desktop hosts such as Javelle JavaFX.
 *
 * <p>This runtime deliberately starts with the portable HTTP capability. It
 * does not emulate browser globals and it does not claim support for plugins
 * whose desktop behavior still requires an app-owned implementation.</p>
 */
public final class JvmDesktopNativeBridgeRuntime implements NativeBridgeRuntime {
  private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30);
  private static final Duration MAX_TIMEOUT = Duration.ofMinutes(2);

  private final HttpClient http;

  public JvmDesktopNativeBridgeRuntime() {
    this(HttpClient.newBuilder()
        .connectTimeout(DEFAULT_TIMEOUT)
        .followRedirects(HttpClient.Redirect.NEVER)
        .build());
  }

  JvmDesktopNativeBridgeRuntime(HttpClient http) {
    this.http = Objects.requireNonNull(http, "http");
  }

  @Override
  public <T> NativePromise<T> call(String action, NativeRequest request, Class<T> resultType) {
    Objects.requireNonNull(resultType, "resultType");
    NativeRequest safe = request == null ? NativeRequest.empty() : request;
    if (!"http.request".equals(action)) {
      return NativePromise.failure(unsupported(safe, action));
    }
    if (resultType != io.javelle.plugins.nativebridge.HttpResponse.class && resultType != Object.class) {
      return NativePromise.failure(NativeError.of(
          "NATIVE_TYPE_MISMATCH",
          "http.request requires HttpResponse result type",
          safe.plugin(),
          safe.action()));
    }

    CompletableFuture<NativeResponse<T>> future;
    try {
      java.net.http.HttpRequest httpRequest = toHttpRequest(safe.payload());
      future = http.sendAsync(httpRequest, BodyHandlers.ofString())
          .<NativeResponse<T>>handle((response, error) -> {
            if (error != null) {
              return NativeResponse.failure(safe.requestId(), NativeError.of(
                  "HTTP_TRANSPORT_ERROR",
                  message(error),
                  safe.plugin(),
                  safe.action()));
            }
            Map<String, String> headers = new LinkedHashMap<>();
            response.headers().map().forEach((name, values) -> headers.put(name, String.join(", ", values)));
            io.javelle.plugins.nativebridge.HttpResponse result = new io.javelle.plugins.nativebridge.HttpResponse(
                response.statusCode(),
                response.statusCode() >= 200 && response.statusCode() < 300,
                response.uri().toString(),
                headers,
                response.body());
            return NativeResponse.success(safe.requestId(), resultType.cast(result));
          });
    } catch (RuntimeException error) {
      return NativePromise.failure(NativeError.of(
          "HTTP_REQUEST_INVALID",
          message(error),
          safe.plugin(),
          safe.action()));
    }
    return NativePromise.fromFuture(future);
  }

  @Override
  public WatchHandle watch(String action, NativeRequest request, NativeEventHandler handler) {
    Objects.requireNonNull(handler, "handler");
    NativeRequest safe = request == null ? NativeRequest.empty() : request;
    handler.handle(NativeResponse.failure(safe.requestId(), unsupported(safe, action)));
    return new WatchHandle(() -> { });
  }

  @Override
  public PluginCapability capability(String plugin) {
    if ("http".equals(plugin)) {
      return PluginCapability.supported("http", "jvm-desktop", Set.of("http.request"), Set.of(Permission.NETWORK));
    }
    return PluginCapability.unsupported(plugin, "jvm-desktop", "No pure JVM desktop backend is installed for this plugin");
  }

  @Override
  public PermissionStatus check(Permission permission) {
    return permission == Permission.NETWORK
        ? PermissionStatus.granted(permission)
        : PermissionStatus.unavailable(permission, "No pure JVM desktop permission backend is installed");
  }

  @Override
  public NativePromise<PermissionStatus> request(Permission permission) {
    return NativePromise.success(check(permission));
  }

  private static java.net.http.HttpRequest toHttpRequest(Map<String, Object> payload) {
    String method = string(payload, "method").toUpperCase();
    String url = string(payload, "url");
    if (!Set.of("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD").contains(method)) {
      throw new IllegalArgumentException("Unsupported HTTP method: " + method);
    }
    URI uri = URI.create(url);
    if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null) {
      throw new IllegalArgumentException("HTTP URL must use absolute http:// or https://");
    }

    long timeoutMillis = number(payload.get("timeoutMillis"));
    Duration timeout = timeoutMillis <= 0
        ? DEFAULT_TIMEOUT
        : Duration.ofMillis(Math.min(timeoutMillis, MAX_TIMEOUT.toMillis()));
    java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder(uri).timeout(timeout);
    Object headers = payload.get("headers");
    if (headers instanceof Map<?, ?> map) {
      map.forEach((name, value) -> {
        if (name != null && value != null) builder.header(String.valueOf(name), String.valueOf(value));
      });
    }
    String body = payload.get("body") == null ? null : String.valueOf(payload.get("body"));
    return builder.method(method, body == null ? BodyPublishers.noBody() : BodyPublishers.ofString(body)).build();
  }

  private static String string(Map<String, Object> payload, String key) {
    Object value = payload == null ? null : payload.get(key);
    if (value == null || String.valueOf(value).isBlank()) throw new IllegalArgumentException(key + " is required");
    return String.valueOf(value).trim();
  }

  private static long number(Object value) {
    if (value instanceof Number number) return number.longValue();
    if (value == null) return 0L;
    try {
      return Long.parseLong(String.valueOf(value));
    } catch (NumberFormatException ignored) {
      return 0L;
    }
  }

  private static NativeError unsupported(NativeRequest request, String action) {
    return NativeError.of(
        "NATIVE_UNSUPPORTED_ACTION",
        "No pure JVM desktop handler for " + String.valueOf(action),
        request.plugin(),
        request.action());
  }

  private static String message(Throwable error) {
    Throwable cause = error.getCause() == null ? error : error.getCause();
    return cause.getMessage() == null ? cause.getClass().getName() : cause.getMessage();
  }
}

