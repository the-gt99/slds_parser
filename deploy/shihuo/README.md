# Shihuo gateway

На сервере сайта работает только сетевой шлюз: выделенный WireGuard-интерфейс, transparent mitmproxy и синхронизация peers с API парсера. PostgreSQL, профили устройств и другие данные парсера на этом сервере не хранятся.

## Разделение секретов

- `/etc/wireguard/private.key` содержит private key сервера WireGuard.
- `/etc/slds-shihuo-gateway.env` содержит случайный `SHIHUO_GATEWAY_TOKEN` и доступен только root.
- Парсер получает только SHA-256 отпечаток этого токена в `SHIHUO_GATEWAY_TOKEN_HASH`.
- Private key CA остаётся в `/var/lib/slds-shihuo/mitmproxy`; на парсер копируется только публичный `mitmproxy-ca-cert.cer`.

## Runtime шлюза

Нужны `wireguard-tools`, `python3-venv` и `iptables`. Файлы `mitmproxy_addon.py`, `gateway_reconcile.py` и `requirements.txt` устанавливаются в `/opt/slds-shihuo-gateway`, виртуальное окружение — в `/opt/slds-shihuo-gateway/venv`. Сервис mitmproxy работает от отдельного пользователя `slds-shihuo` и слушает только `10.77.0.1:8080`.

Пример `/etc/slds-shihuo-gateway.env`:

```text
SHIHUO_PARSER_BASE_URL=https://parser.example
SHIHUO_GATEWAY_TOKEN=<случайный секрет>
SHIHUO_WIREGUARD_INTERFACE=wg0
```

`wg0` использует адрес `10.77.0.1/24`, UDP-порт `51820` и `SaveConfig = false`. Firewall должен:

- разрешать UDP/51820 на внешнем интерфейсе;
- запрещать обмен трафиком между клиентами `wg0`;
- перенаправлять TCP/80 и TCP/443 из `wg0` на `10.77.0.1:8080`;
- разрешать из `wg0` только DNS наружу; QUIC/UDP 443 не разрешать, чтобы приложение использовало перехватываемый TCP;
- делать MASQUERADE только для `10.77.0.0/24` на внешнем интерфейсе.

После первого запуска mitmproxy создаёт CA. Затем публичный `.cer` передаётся парсеру, а его путь задаётся через `SHIHUO_CA_CERT_PATH`. На парсере также задаются public key WireGuard шлюза, endpoint шлюза и hash токена. После этого включаются `slds-shihuo-mitmproxy.service` и `slds-shihuo-wireguard-reconcile.timer`.

Addon принимает только гостевой поисковый запрос к `sh-gateway.shihuo.cn/v3/sh-api/daga/search/goods/v1`, отклоняет запросы с признаками авторизации, оставляет ровно шесть разрешённых полей и сразу отправляет их по HTTPS на парсер. Локальные файлы и база данных для профилей не используются.
