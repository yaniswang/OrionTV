package com.oriontv

import android.content.Context
import com.facebook.react.modules.network.OkHttpClientProvider
import java.security.KeyStore
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * Android 7.1.1 以下的系统信任库不包含 ISRG Root X1/X2。
 * Network Security Config 从 Android 7.0 才生效，因此这里统一给 RN 的
 * 全局 OkHttp 客户端补充 Let's Encrypt 根证书，fetch、XHR 和 react-native-video
 * 都会复用该客户端。
 */
object LegacyTls {
  fun configure(context: Context) {
    val trustManager = CompositeTrustManager(
      listOf(
        createSystemTrustManager(),
        createBundledTrustManager(context.applicationContext),
      ),
    )
    val sslContext = SSLContext.getInstance("TLS")
    sslContext.init(null, arrayOf(trustManager), null)

    OkHttpClientProvider.setOkHttpClientFactory {
      OkHttpClientProvider.createClientBuilder(context.applicationContext)
        .sslSocketFactory(sslContext.socketFactory, trustManager)
        .build()
    }
  }

  private fun createSystemTrustManager(): X509TrustManager {
    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(null as KeyStore?)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  private fun createBundledTrustManager(context: Context): X509TrustManager {
    val keyStore = KeyStore.getInstance(KeyStore.getDefaultType())
    keyStore.load(null, null)

    val certificateFactory = CertificateFactory.getInstance("X.509")
    listOf(R.raw.isrg_root_x1, R.raw.isrg_root_x2).forEachIndexed { index, certificateRes ->
      context.resources.openRawResource(certificateRes).use { stream ->
        keyStore.setCertificateEntry("isrg_root_$index", certificateFactory.generateCertificate(stream))
      }
    }

    val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
    factory.init(keyStore)
    return factory.trustManagers.filterIsInstance<X509TrustManager>().first()
  }

  private class CompositeTrustManager(
    private val delegates: List<X509TrustManager>,
  ) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
      tryDelegates { it.checkClientTrusted(chain, authType) }
    }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
      tryDelegates { it.checkServerTrusted(chain, authType) }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> {
      return delegates.flatMap { it.acceptedIssuers.asList() }.toTypedArray()
    }

    private fun tryDelegates(check: (X509TrustManager) -> Unit) {
      var lastError: CertificateException? = null
      delegates.forEach { delegate ->
        try {
          check(delegate)
          return
        } catch (error: CertificateException) {
          lastError = error
        }
      }
      throw lastError ?: CertificateException("No X509TrustManager available")
    }
  }
}