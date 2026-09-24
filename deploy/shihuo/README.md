# Shihuo guest devices

Секреты и runtime-конфигурация не входят в репозиторий. На сервере должны быть установлены `wireguard-tools`, `python3-venv`, `iptables` и Node.js 22.

1. Создать `/etc/wireguard/private.key` командой `umask 077; wg genkey > /etc/wireguard/private.key` и получить public key через `wg pubkey` без вывода private key.
2. Создать root-only `/etc/wireguard/wg0.conf` с адресом `10.77.0.1/24`, UDP-портом `51820`, сохранённым private key и `SaveConfig = false`.
3. Включить IPv4 forwarding. В firewall разрешить UDP/51820, DNS из `wg0`, TCP/80 и TCP/443 из `wg0`; запретить `wg0 → wg0` и другие исходящие протоколы.
4. Перенаправить TCP/80 и TCP/443, пришедшие через `wg0`, в transparent mitmproxy на порт 8080. Порт 8080 с внешних интерфейсов должен быть запрещён.
5. Создать `/srv/slds-parser/venv-shihuo`, установить зависимости из `requirements.txt`; каталог `/srv/slds-parser/state/mitmproxy` должен принадлежать `slds-parser` и иметь режим `0700`.
6. Первый локальный запуск mitmproxy создаёт CA. Private key остаётся только в runtime-каталоге с режимом `0600`; публичный `.cer` задаётся через `SHIHUO_CA_CERT_PATH`.
7. Установить systemd units и polkit rule из `deploy/`, применить миграции, собрать приложение, затем включить `wg-quick@wg0`, `slds-shihuo-mitmproxy` и reconcile timer.

Пример firewall-логики (интерфейс выхода следует определить на сервере):

```text
iptables -A FORWARD -i wg0 -o wg0 -j REJECT
iptables -A FORWARD -i wg0 -p udp --dport 53 -j ACCEPT
iptables -A FORWARD -i wg0 -p tcp -m multiport --dports 80,443,53 -j ACCEPT
iptables -A FORWARD -i wg0 -j REJECT
iptables -t nat -A PREROUTING -i wg0 -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 8080
```

Правила необходимо сделать идемпотентными и сохранить штатным механизмом дистрибутива. PostgreSQL, порт 8080 и любые control-интерфейсы наружу не публикуются.
