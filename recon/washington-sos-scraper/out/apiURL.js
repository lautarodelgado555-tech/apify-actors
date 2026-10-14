var aPIURL =
{
    baseUrl: "https://ccfs-api.prod.sos.wa.gov/api".indexOf("#") == 0 ? "http://localhost:54783/api/" : "https://ccfs-api.prod.sos.wa.gov/api/",
    serviceUrl: "https://ccfs-api.prod.sos.wa.gov/api".indexOf("#") == 0 ? "http://localhost:54783/api" : "https://ccfs-api.prod.sos.wa.gov/api",
    appInsightsConnectionString: "InstrumentationKey=06794cf5-93b9-4b22-9893-18b0d9427f68;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/".indexOf("#") == 0 ? "InstrumentationKey=36964562-3be2-405e-9eec-92afaa696a5b;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/" : "InstrumentationKey=06794cf5-93b9-4b22-9893-18b0d9427f68;IngestionEndpoint=https://westus2-2.in.applicationinsights.azure.com/;LiveEndpoint=https://westus2.livediagnostics.monitor.azure.com/",
    env: "prod".indexOf("#") == 0 ? "local" : "prod",
    clientToken: "pubc890dbe7364a4261edbcab8703162b5c".indexOf("#") == 0 ? "pubc890dbe7364a4261edbcab8703162b5c" : "pubc890dbe7364a4261edbcab8703162b5c",
    applicationId: "1c9110db-6ced-45a4-9e67-38445638280e".indexOf("#") == 0 ? "1c9110db-6ced-45a4-9e67-38445638280e" : "1c9110db-6ced-45a4-9e67-38445638280e",
    sessionReplaySampleRate: "0".indexOf("#") == 0 ? 0 : Number("0"),
    sessionSampleRate: "100".indexOf("#") == 0 ? 0 : Number("100"),
    turnstileSiteKey: "0x4AAAAAABLh8fs_3VYXfD20".indexOf("#") == 0 ? "0x4AAAAAAA7WYz077_2PIbgJ" : "0x4AAAAAABLh8fs_3VYXfD20",
    turnstileEnable: window.location.hostname.indexOf("localhost") != -1 || "1".indexOf("#") == 0 ? 1 : Number("1")
}
window.aPIURL = aPIURL;