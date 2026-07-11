package io.javelle.plugins;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import io.javelle.plugins.nativebridge.Http;
import io.javelle.plugins.nativebridge.HttpResponse;
import io.javelle.plugins.nativebridge.JvmDesktopNativeBridgeRuntime;
import io.javelle.plugins.nativebridge.NativeBridge;
import java.net.InetSocketAddress;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class JvmDesktopNativeBridgeRuntimeTest {
  @AfterEach
  void resetBridge() {
    NativeBridge.reset();
  }

  @Test
  void backsTheJavelleHttpFacadeOnPureJvmDesktop() throws Exception {
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/health", exchange -> {
      byte[] body = "{\"status\":\"ok\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8);
      exchange.getResponseHeaders().add("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      exchange.getResponseBody().write(body);
      exchange.close();
    });
    server.start();
    try {
      NativeBridge.install(new JvmDesktopNativeBridgeRuntime());
      HttpResponse response = Http.get("http://127.0.0.1:" + server.getAddress().getPort() + "/health").getOrThrow();
      assertEquals(200, response.status());
      assertTrue(response.ok());
      assertEquals("{\"status\":\"ok\"}", response.body());
      assertTrue(NativeBridge.capability("http").supported());
      assertFalse(NativeBridge.capability("camera").supported());
    } finally {
      server.stop(0);
    }
  }
}

