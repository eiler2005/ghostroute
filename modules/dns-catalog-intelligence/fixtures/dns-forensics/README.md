# DNS Forensics Fixtures

Фикстуры для локального smoke-теста `modules/dns-catalog-intelligence/bin/dns-forensics-report`.

Здесь мы проверяем не живой роутер и не `dnsmasq`, а стабильный текстовый контракт forensic snapshot:

- `WINDOW`
- `CLIENT`
- `TOPDOMAIN`
- `TOPFAMILY`

Это позволяет безопасно менять renderer и reader-логику без обязательного доступа к роутеру.

Дополнительно здесь лежит sample `dnsmasq` log для smoke-теста router-side writer режима
`domain-auto-add.sh --forensics-only`.
