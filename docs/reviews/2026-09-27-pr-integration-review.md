# Fleet: 27 Eylül 2026 PR bütünleştirme incelemesi

## Karar ve kaynaklar

#14, #15, #18 ve #19 birlikte incelendi. Kaynak zinciri Git ancestry ile
doğrulandı: #14 → #15 → #18 → #19. İncelemenin başlangıcındaki #19 başı
`10c0aa92b7b3117f207f898f6284b6bd38437180` idi. İki runtime engeli ve bir
konsol sorunu düzeltildikten sonra birleşik yerel kalite kapısı geçti.
Uzak son-head kontrolleri ve gerçek merge durumu ilgili PR/Actions kayıtlarından
ayrıca doğrulanmalıdır; bu belge yerel testleri uzak test gibi sunmaz.

| Kaynak | İncelenen kapsam |
| --- | --- |
| #14 | Büyük transcript okuması, report-only repair, ortam preflight, continuation recovery, token sayaçları |
| #15 | Gerçek CLI/IPC, bekleme ve recovery komutları, kurulu/applied runtime yönlendirmesi, güvenilir durum gösterimi |
| #18 | Scope/group ayrımı, KITE, read-only oturumlar, tek uçuşlu yenileme, mouse hedefleme ve küçük terminal |
| #19 | JSON control/client, sayfalama, kaynak fingerprint/kanıt ledger, bağımsız verifier bağlama, hazırlanan planlar |
| #20/#21 | CodeQL init ve analyze adımlarının aynı resmi v4.38.1 commit'ine birlikte alınması |

Geliştirme zincirinde 75 değişen dosya vardı. İnceleme risk odaklıdır:
runtime/scheduler, makine kontrolü ve source/evidence/planner bağımsız inceleme
yüzeylerine ayrıldı; root admission, entrypoint, paketleme, skill/doküman ve CI
yüzeylerini karşılaştırdı. Bu çalışma tam bir düşmanca OS izolasyonu denetimi değildir.

## Bulunan ve düzeltilen sorunlar

| Öncelik | Sorun | Düzeltme ve davranış kanıtı |
| --- | --- | --- |
| P1 | Otomatik reconciliation, henüz yanıtı gelmeyen devam isteğinin yazıcı rezervasyonunu bırakabiliyordu. Gecikmiş probe da yeni denemenin rezervasyonunu silebiliyordu. | `scheduler.mjs:982` ve `:1375`: yalnız `outcome_unknown` probe edilir; await sonrasında aynı rezervasyon ve pending deneme kimliği yeniden denetlenir. Başlatılmakta olan deneme, otomatik ve manuel stale-probe yarışları test edildi. |
| P1 | Read-only report repair, `continue_within_authority` veya redundant approval raporuyla tekrar workspace-write turuna dönebiliyordu. | `lane-outcome.mjs:453`: repair sonrasında bu raporlar `outcome_unknown` olur. Gerçek runtime-adapter/fake broker testi yalnız `[workspaceWrite, readOnly]` dispatch politikalarını gördü; üçüncü writable tur oluşmadı. |
| P2 | Dinamik konsol footer'ı UTF-16 uzunluğuna göre kırpıldığı için geniş Unicode karakterleri terminali taşırabiliyordu. | `console-controller.mjs:54`: grapheme ve terminal display width ile kırpma. Gerçek controller notice/filter yolları, geniş karakterler, emoji ve birleşik karakterlerle test edildi. |

Regresyonlar düzeltmeden önce başarısız görüldü, düzeltme sonrasında geçti.
Son düzeltmeler ayrıca yazıcılarından bağımsız olarak incelendi; dört odaklı
süitte 31/31 test başarılıydı. Reconciliation'ın iki probe yolu birlikte
düzeltildi; ortak `decideLaneOutcome` runtime'ın tamamlanma yolunu koruyor.
Git blame, reconciliation kodunu #14'e; eski continuation kararını daha önceki
`a9542a55` commit'ine bağlıyor. Sorunların tamamı #19 tarafından yaratılmış değildir.

CodeQL'in iki ayrı PR'ı tek başına init/analyze sürümlerini uyuşmaz bırakıyordu.
#20'ye eşleşen init güncellemesi de eklendi. Her iki pin resmi v4.38.1 tag'inin
dereference edilmiş `1c5b675653bb5c22dbe9b12b556ec555138e09fd` commit'idir.
Bu içerik #20 üzerinden main'e birleştirildi; #21 aynı içerik zaten alındığı için kapatıldı.

## Yerel doğrulama

Windows x64, Node 22.20.0, Claude Code 2.1.283 üzerinde `npm run verify`, çıkış 0:

- 610 test: 609 başarılı, 0 başarısız, 1 POSIX socket testi platform atlaması.
- Syntax kontrolleri ve strict Claude plugin doğrulaması başarılı.
- Secret taraması: 250 dosya, 0 bulgu; iki bağımlılığın lisans kontrolü başarılı.
- Performans: startup p95 yaklaşık 7.10 ms, idle CPU %0, redraw 4 Hz,
  retained heap yaklaşık 2.06 MiB, sentetik orphan sayısı 0.
- Doküman kapısı: 60 dosya, 65 bağlantı, 0 bozuk bağlantı.
- Control-performance kapısı başarılı; sonuçlar sentetik payload/yerel gecikme
  ölçümleridir, token maliyeti, abonelik kotası veya gerçek görev kalitesi değildir.

Bu rapor sonradan eklendiği için doküman/secret kapıları ayrıca yeniden çalıştırılır.
Paket/release-check temiz commit üzerinde ayrıca uygulanır; yeni release yayınlama
veya kurulu runtime değişikliği bu kabul işleminin parçası değildir.

## Kalan sınırlar

- Authenticated model, tarayıcı, veritabanı veya dış işlem canary'si yapılmadı.
- Source-bound receipt raporlanan kanıtı içerikle bağlar; testleri kendisi yürütmez,
  imzalı provenance veya release izni sağlamaz. Ignored bağımlılıklar ve dış sistem
  durumu kaynak bağının dışındadır; filesystem snapshot atomik değildir.
- Kilitler aynı supervisor/workspace içinde geçerlidir; farklı supervisor veya
  aynı OS kullanıcısının başka süreci için global fencing sağlamaz.
- Planner bütçeleri tahmindir; provider harcama/kota limiti değildir.
- `events` protokol bölümü korunur, fakat mevcut scheduler olay geçmişi saklamaz.
  Boş liste olay yaşanmadığını kanıtlamaz; bu sınır MACHINE_CONTROL.md'de netleştirildi.
- Kaynak sürümü 0.3.0 kaldı. Bu commit'ler eski kopyalanmış 0.3.0 kurulumunu
  kendiliğinden yenilemez; sürümleme ve kurulu runtime yükseltmesi ayrı teslimdir.
