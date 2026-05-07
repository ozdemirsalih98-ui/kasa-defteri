// ============================================================
// 1. FIREBASE YAPILANDIRMASI
// Projeye ait bağlantı bilgileri.
// Yeni bir firma için sadece bu bloğu güncellemek yeterlidir.
// ============================================================

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updatePassword, setPersistence, browserLocalPersistence, browserSessionPersistence, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, getDocs, addDoc, updateDoc, deleteDoc, collection, query, where, orderBy, onSnapshot, serverTimestamp, Timestamp, increment } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBlYSJbBnkL-PoPM_VH3uLDBe545awkO04",
  authDomain: "aktepe-94711.firebaseapp.com",
  projectId: "aktepe-94711",
  storageBucket: "aktepe-94711.firebasestorage.app",
  messagingSenderId: "721383862652",
  appId: "1:721383862652:web:dc1de116bacae16f5c74f9"
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

// Kullanıcı adını Firebase Auth'un gerektirdiği e-posta formatına çevirir.
// Kullanıcıya hiçbir zaman gösterilmez.
function kuadEmaile(kullaniciAdi) {
  return `${kullaniciAdi.toLowerCase().trim()}@${FIREBASE_CONFIG.projectId}.app`;
}


// ============================================================
// 2. UYGULAMA DURUMU
// Aktif kullanıcı, geçerli sayfa ve arka plan işlemleri için
// merkezi durum nesnesi. Sayfa değişimlerinde temizlenir.
// ============================================================

const durum = {
  kullanici: null,        // { uid, kullaniciAdi, adSoyad, rol }
  sayfa: null,            // aktif sayfa adı
  timerIdler: [],         // aktif masa süre sayaçları
  snapshotTemizle: null,  // aktif Firestore gerçek zamanlı dinleyici
  firmaAdi: "AKTEPE BİLARDO", // sistem/firma dokümanından yüklenir
};

const TUR_LISTESI = [
  { id: "gelir",          etiket: "Gelir" },
  { id: "gider",          etiket: "Gider" },
  { id: "tahsilat",       etiket: "Tahsilat" },
  { id: "transfer_giris", etiket: "Transfer Giriş" },
  { id: "transfer_cikis", etiket: "Transfer Çıkış" },
];


// ============================================================
// 3. YARDIMCI FONKSİYONLAR
// Para formatlama, süre hesaplama ve DOM işlemleri için
// tekrar kullanılan küçük fonksiyonlar.
// ============================================================

function paraBicimlendir(tutar) {
  return Number(tutar || 0).toLocaleString("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }) + " ₺";
}

function sureHesapla(acilisMs) {
  const sn = Math.floor((Date.now() - acilisMs) / 1000);
  const s  = Math.floor(sn / 3600).toString().padStart(2, "0");
  const d  = Math.floor((sn % 3600) / 60).toString().padStart(2, "0");
  const ss = (sn % 60).toString().padStart(2, "0");
  return `${s}:${d}:${ss}`;
}

function sureUcretiHesapla(acilisMs, saatlikUcret) {
  if (!saatlikUcret) return 0;
  return ((Date.now() - acilisMs) / 3600000) * saatlikUcret;
}

function bugunBaslangic() {
  const now = new Date();
  const d = new Date(now);
  // 00:00–05:59 arası hâlâ önceki iş gününe ait
  if (now.getHours() < 6) d.setDate(d.getDate() - 1);
  d.setHours(6, 0, 0, 0);
  return Timestamp.fromDate(d);
}

function elem(id) {
  return document.getElementById(id);
}

function formatTarihSaat(dt) {
  if (!dt) return "—";
  return `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${String(dt.getFullYear()).slice(-2)} ${dt.toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"})}`;
}

async function authHesabiniSil(kullaniciAdi, sifre) {
  const ikApp = initializeApp(FIREBASE_CONFIG, `sil_${Date.now()}`);
  const ikAuth = getAuth(ikApp);
  try {
    const kred = await signInWithEmailAndPassword(ikAuth, kuadEmaile(kullaniciAdi), sifre || "123456");
    await kred.user.delete();
  } catch { /* sessiz */ } finally {
    await deleteApp(ikApp).catch(() => {});
  }
}

function turkceTemizle(str) {
  return str
    .replace(/[çÇ]/g, "c").replace(/[ğĞ]/g, "g")
    .replace(/[ıİ]/g, "i").replace(/[öÖ]/g, "o")
    .replace(/[şŞ]/g, "s").replace(/[üÜ]/g, "u");
}

function temizleTimerlar() {
  durum.timerIdler.forEach(clearInterval);
  durum.timerIdler = [];
}

function temizleListener() {
  if (durum.snapshotTemizle) {
    durum.snapshotTemizle();
    durum.snapshotTemizle = null;
  }
}

function modalKapat() {
  ["masa-modal", "urun-modal", "odeme-modal", "gecmis-modal"].forEach(id => elem(id)?.remove());
}


// ============================================================
// 4. KİMLİK DOĞRULAMA
// Kullanıcı adı + şifre ile giriş ve oturum takibi.
// E-posta adresi sisteme dahil değildir.
// ============================================================

async function girisYap(kullaniciAdi, sifre, beniHatirla = true) {
  await setPersistence(auth, beniHatirla ? browserLocalPersistence : browserSessionPersistence);
  await signInWithEmailAndPassword(auth, kuadEmaile(kullaniciAdi), sifre);
}

async function cikisYap() {
  temizleTimerlar();
  temizleListener();
  await signOut(auth);
}


// ============================================================
// 5. ROUTER
// Hash tabanlı sayfa yönlendirme.
// URL'deki # değerine göre ilgili sayfa fonksiyonu çağrılır.
// Sayfa değişiminde timer'lar ve dinleyiciler temizlenir.
// ============================================================

function sayfayaGit(sayfa) {
  window.location.hash = sayfa;
}

function routerBaslat() {
  window.addEventListener("hashchange", () => sayfaGoster(window.location.hash.slice(1)));
  sayfaGoster(window.location.hash.slice(1) || "masalar");
}

function sayfaGoster(sayfa) {
  temizleTimerlar();
  temizleListener();
  durum.sayfa = sayfa;

  document.querySelectorAll(".alt-nav a").forEach(a => {
    a.classList.toggle("aktif", a.dataset.sayfa === sayfa);
  });

  const kapsayici = elem("sayfa-icerigi");
  if (!kapsayici) return;

  switch (sayfa) {
    case "masalar":   return masalarSayfasi(kapsayici);
    case "kasalar":   return kasalarSayfasi(kapsayici);
    case "oyuncular": return oyuncularSayfasi(kapsayici);
    case "yonetim":   return yonetimSayfasi(kapsayici);
    default:          return masalarSayfasi(kapsayici);
  }
}


// ============================================================
// 6. GİRİŞ EKRANI
// Kullanıcı adı ve şifre ile giriş formu.
// Hatalı girişte kullanıcıya mesaj gösterilir.
// ============================================================

function girisEkraniGoster() {
  elem("uygulama").innerHTML = `
    <div class="giris-kapsayici">
      <div class="giris-kart">
        <h1>${durum.firmaAdi}</h1>
        <form id="giris-form">
          <input type="text" id="giris-kullanici" placeholder="Kullanıcı Adı" autocomplete="username" required />
          <input type="password" id="giris-sifre" placeholder="Şifre" autocomplete="current-password" required />
          <label class="beni-hatirla-label">
            <input type="checkbox" id="giris-beni-hatirla" checked />
            Beni Hatırla
          </label>
          <p id="giris-hata" class="hata gizli"></p>
          <button type="submit">Giriş Yap</button>
        </form>
      </div>
    </div>
  `;

  elem("giris-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const hataEl = elem("giris-hata");
    hataEl.classList.add("gizli");
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    btn.textContent = "Giriş yapılıyor...";

    try {
      await girisYap(elem("giris-kullanici").value, elem("giris-sifre").value, elem("giris-beni-hatirla").checked);
    } catch {
      hataEl.textContent = "Kullanıcı adı veya şifre hatalı.";
      hataEl.classList.remove("gizli");
      btn.disabled = false;
      btn.textContent = "Giriş Yap";
    }
  });
}


// ============================================================
// 7. ANA LAYOUT
// Rol bazlı kenar çubuğu (sidebar) ve sayfa kapsayıcısı.
// Admin tüm menüleri, eleman sadece izin verilenleri görür.
// ============================================================

const NAV_MENULERI = [
  { sayfa: "masalar",   etiket: "Masalar",   ikon: "🎱", roller: ["admin", "eleman"] },
  { sayfa: "kasalar",   etiket: "Kasalar",   ikon: "💰", roller: ["admin"] },
  { sayfa: "oyuncular", etiket: "Oyuncular", ikon: "👥", roller: ["admin", "eleman"] },
  { sayfa: "yonetim",   etiket: "Yönetim",   ikon: "⚙️", roller: ["admin"] },
];

function layoutGoster() {
  const menuHtml = NAV_MENULERI
    .filter(m => m.roller.includes(durum.kullanici.rol))
    .map(m => `<a href="#${m.sayfa}" data-sayfa="${m.sayfa}"><span class="nav-ikon">${m.ikon}</span>${m.etiket}</a>`)
    .join("");

  elem("uygulama").innerHTML = `
    <div class="layout">
      <header class="ust-bar">
        <span class="ust-bar-logo">${durum.firmaAdi}</span>
        <div class="ust-bar-sag">
          <span class="ust-bar-kullanici">${durum.kullanici.adSoyad}</span>
          <button id="cikis-btn">Çıkış</button>
        </div>
      </header>
      <main class="ana-icerik">
        <div id="sayfa-icerigi"></div>
      </main>
      <nav class="alt-nav">${menuHtml}</nav>
    </div>
  `;

  elem("cikis-btn").addEventListener("click", cikisYap);
  routerBaslat();
  pullToRefreshBagla();
}

function pullToRefreshBagla() {
  const ESIK = 72;
  let basY = 0, aktif = false, yenileniyor = false;

  let ptr = document.getElementById("ptr-indicator");
  if (!ptr) {
    ptr = document.createElement("div");
    ptr.id = "ptr-indicator";
    ptr.innerHTML = `<div class="ptr-ok">↻</div>`;
    document.body.prepend(ptr);
  }

  document.addEventListener("touchstart", e => {
    if (yenileniyor || window.scrollY > 0) return;
    basY = e.touches[0].clientY;
    aktif = true;
  }, { passive: true });

  document.addEventListener("touchmove", e => {
    if (!aktif) return;
    const cekme = Math.max(0, Math.min(e.touches[0].clientY - basY, ESIK * 1.5));
    if (cekme > 0) {
      ptr.style.height = `${cekme * 0.55}px`;
      ptr.style.opacity = Math.min(cekme / ESIK, 1);
      ptr.querySelector(".ptr-ok").style.transform = `rotate(${cekme * 2.5}deg)`;
    }
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!aktif) return;
    aktif = false;
    const h = parseFloat(ptr.style.height || "0");
    ptr.style.height = "0";
    ptr.style.opacity = "0";
    if (h >= ESIK * 0.42 && !yenileniyor) {
      yenileniyor = true;
      sayfaGoster(durum.sayfa);
      setTimeout(() => { yenileniyor = false; }, 1000);
    }
  });
}


// ============================================================
// 7.5 OYUNCU LAYOUT
// Oyuncu rolüyle giriş yapıldığında admin layoutu yerine
// sadece kendi profilini gösteren basit ekran açılır.
// İlk girişte şifre değiştirme ve profil tamamlama akışı çalışır.
// ============================================================

function oyuncuLayoutGoster() {
  elem("uygulama").innerHTML = `
    <div class="layout">
      <header class="ust-bar">
        <span class="ust-bar-logo">${durum.firmaAdi}</span>
        <div class="ust-bar-sag">
          <span class="ust-bar-kullanici">${durum.kullanici.adSoyad}</span>
          <button id="cikis-btn">Çıkış</button>
        </div>
      </header>
      <main class="ana-icerik" style="padding-bottom:24px">
        <div id="sayfa-icerigi"><p class="bos-mesaj">Yükleniyor...</p></div>
      </main>
    </div>
  `;
  elem("cikis-btn").addEventListener("click", cikisYap);

  if (durum.kullanici.ilkGiris) {
    sifreDegistirModalAc(true);
  } else {
    profilEksikKontrol();
  }
}

async function sifreDegistirModalAc(zorunlu = false) {
  elem("sifre-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "sifre-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${zorunlu ? "Şifrenizi Değiştirin" : "Şifre Değiştir"}</h3>
      ${zorunlu ? `<p class="profil-aciklama">İlk girişiniz. Güvenliğiniz için lütfen şifrenizi değiştirin.</p>` : ""}
      <form id="sifre-form">
        <input type="password" id="sifre-yeni" placeholder="Yeni Şifre (en az 6 karakter)" minlength="6" required />
        <input type="password" id="sifre-tekrar" placeholder="Şifreyi Tekrar Girin" required />
        <p id="sifre-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Kaydet</button>
          ${!zorunlu ? `<button type="button" id="btn-sifre-iptal" class="btn-iptal">İptal</button>` : ""}
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  if (!zorunlu) {
    modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
    elem("btn-sifre-iptal")?.addEventListener("click", () => modal.remove());
  }

  elem("sifre-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const hataEl = elem("sifre-hata");
    hataEl.classList.add("gizli");
    const yeni = elem("sifre-yeni").value;
    const tekrar = elem("sifre-tekrar").value;
    if (yeni !== tekrar) {
      hataEl.textContent = "Şifreler eşleşmiyor.";
      hataEl.classList.remove("gizli");
      return;
    }
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await updatePassword(auth.currentUser, yeni);
      await updateDoc(doc(db, "kullanicilar", durum.kullanici.uid), { ilkGiris: false, sifre: yeni });
      durum.kullanici.ilkGiris = false;
      modal.remove();
      profilEksikKontrol();
    } catch (err) {
      hataEl.textContent = err.code === "auth/requires-recent-login"
        ? "Yeniden giriş yapmanız gerekiyor."
        : "Hata: " + err.message;
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

function profilEksikKontrol() {
  const eksik = !durum.kullanici.tel || !durum.kullanici.email;
  if (eksik) {
    profilTamamlaModalAc();
  } else {
    oyuncuProfilGoster();
  }
}

function profilTamamlaModalAc() {
  elem("profil-tamamla-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "profil-tamamla-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>Profilinizi Tamamlayın</h3>
      <p class="profil-aciklama">İletişim bilgilerinizi girerek profilinizi tamamlayın.</p>
      <form id="profil-form">
        <input type="tel" id="profil-tel" placeholder="Telefon" value="${durum.kullanici.tel || ""}" required />
        <input type="email" id="profil-email" placeholder="E-posta (isteğe bağlı)" value="${durum.kullanici.email || ""}" />
        <p id="profil-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Kaydet</button>
          <button type="button" id="btn-profil-atla" class="btn-iptal">Şimdi Değil</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  elem("btn-profil-atla").addEventListener("click", () => { modal.remove(); oyuncuProfilGoster(); });

  elem("profil-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const tel = elem("profil-tel").value.trim();
    const email = elem("profil-email").value.trim();
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await updateDoc(doc(db, "kullanicilar", durum.kullanici.uid), { tel, email });
      durum.kullanici.tel = tel;
      durum.kullanici.email = email;
      modal.remove();
      oyuncuProfilGoster();
    } catch (err) {
      elem("profil-hata").textContent = "Hata: " + err.message;
      elem("profil-hata").classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

function oyuncuProfilGoster() {
  const k = durum.kullanici;
  const icerik = elem("sayfa-icerigi");
  if (!icerik) return;

  icerik.innerHTML = `
    <div class="sayfa-baslik"><h2>Profilim</h2></div>
    <div class="oyuncu-profil-kart">
      <div class="oyuncu-profil-baslik">
        <div class="oyuncu-ad-buyuk">${k.adSoyad}</div>
        <span class="oyuncu-tip-badge ${k.tip === "bilardo" ? "badge-bilardo" : "badge-genel"}">${k.tip === "bilardo" ? "Bilardo" : "Genel"}</span>
      </div>
      <div class="oyuncu-profil-bilgi">
        <div class="profil-satir"><span>Kullanıcı Adı</span><span>@${k.kullaniciAdi}</span></div>
        <div class="profil-satir"><span>Telefon</span><span>${k.tel || "—"}</span></div>
        <div class="profil-satir"><span>E-posta</span><span>${k.email || "—"}</span></div>
        <div class="profil-satir"><span>Veresiye Bakiyesi</span><span class="${(k.veresiye || 0) > 0 ? "negatif" : "pozitif"}">${paraBicimlendir(k.veresiye || 0)}</span></div>
      </div>
      ${k.tip === "bilardo" ? `
      <div class="oyuncu-istatistik">
        <div class="istatistik-baslik">İstatistikler</div>
        <div class="istatistik-grid">
          <div class="istatistik-kutu">
            <div class="ist-deger">${(k.genelAvg || 0).toFixed(3)}</div>
            <div class="ist-etiket">Genel Avg</div>
          </div>
          <div class="istatistik-kutu">
            <div class="ist-deger">${(k.enYuksekAvg || 0).toFixed(3)}</div>
            <div class="ist-etiket">En Yüksek Avg</div>
          </div>
          <div class="istatistik-kutu">
            <div class="ist-deger">${k.eys1 || 0}</div>
            <div class="ist-etiket">EYS 1</div>
          </div>
          <div class="istatistik-kutu">
            <div class="ist-deger">${k.eys2 || 0}</div>
            <div class="ist-etiket">EYS 2</div>
          </div>
          <div class="istatistik-kutu">
            <div class="ist-deger">${k.toplamPuan || 0}</div>
            <div class="ist-etiket">Toplam Puan</div>
          </div>
        </div>
      </div>` : ""}
      <div class="profil-buton-grup">
        <button id="btn-profil-duzenle" class="btn-ikincil">Bilgileri Düzenle</button>
        <button id="btn-sifre-degistir" class="btn-ikincil">Şifre Değiştir</button>
      </div>
    </div>
  `;

  elem("btn-profil-duzenle").addEventListener("click", profilTamamlaModalAc);
  elem("btn-sifre-degistir").addEventListener("click", () => sifreDegistirModalAc(false));
}


// ============================================================
// 8. MASALAR SAYFASI
// Masaları kategoriye göre gruplar; süreli kategoriler üstte,
// süresiz altta. Her kategoride aktif masalar öne çekilir.
// Süreli aktif masalarda canlı süre sayacı gösterilir.
// ============================================================

function masalarSayfasi(kapsayici) {
  const bugunStr = (() => {
    const now = new Date();
    if (now.getHours() < 6) now.setDate(now.getDate() - 1);
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  })();

  kapsayici.innerHTML = `
    <div class="sayfa-baslik"><h2>Masalar</h2></div>
    <div id="masalar-grid">Yükleniyor...</div>
    <button id="btn-rapor-toggle" class="btn-rapor-toggle">Rapor Göster</button>
    <div class="rapor-bolumu gizli" id="rapor-wrapper">
      <div class="rapor-baslik-satir">
        <h3>Rapor</h3>
        <div class="rapor-tarih-bant">
          <input type="date" id="rapor-bas" value="${bugunStr}" />
          <span class="rapor-tarih-ayrac">–</span>
          <input type="date" id="rapor-bit" value="${bugunStr}" />
          <button id="rapor-goster-btn" class="btn-birincil btn-kucuk">Göster</button>
        </div>
      </div>
      <div id="rapor-icerik"></div>
    </div>
  `;

  async function raporGoster() {
    const icerik = elem("rapor-icerik");
    if (!icerik) return;
    icerik.innerHTML = `<p class="bos-mesaj">Yükleniyor...</p>`;

    const basStr = elem("rapor-bas").value;
    const bitStr = elem("rapor-bit").value;
    if (!basStr || !bitStr) { icerik.innerHTML = `<p class="bos-mesaj">Tarih seçiniz.</p>`; return; }

    const [basY, basM, basG] = basStr.split("-").map(Number);
    const [bitY, bitM, bitG] = bitStr.split("-").map(Number);
    const basTarih = new Date(basY, basM - 1, basG, 6, 0, 0, 0);
    const bitTarih = new Date(bitY, bitM - 1, bitG + 1, 6, 0, 0, 0);

    const [hareketSnap, kasaSnap] = await Promise.all([
      getDocs(collection(db, "kasaHareketleri")),
      getDocs(query(collection(db, "kasalar"), orderBy("sira"))),
    ]);
    const kasalar = kasaSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const kasaMap = {};
    kasalar.forEach(k => { kasaMap[k.id] = k.ad; });

    const filtreli = hareketSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => {
        if (!r.tarih) return false;
        const t = r.tarih.toDate();
        return t >= basTarih && t < bitTarih;
      });

    const sureli  = filtreli.filter(r => r.sureli === true);
    const suresiz = filtreli.filter(r => r.sureli === false);

    icerik.innerHTML = `
      <div class="rapor-kartlar">
        <div class="rapor-kart">
          <div class="rapor-kart-baslik">Süreli Masalar</div>
          ${raporVeriRenderle(sureli, kasaMap)}
        </div>
        <div class="rapor-kart">
          <div class="rapor-kart-baslik">Süresiz Masalar</div>
          ${raporVeriRenderle(suresiz, kasaMap)}
        </div>
        <div class="rapor-kart rapor-kart-genel">
          <div class="rapor-kart-baslik">Genel Toplam</div>
          ${raporVeriRenderle(filtreli, kasaMap)}
        </div>
      </div>
    `;
  }

  elem("rapor-goster-btn").addEventListener("click", raporGoster);

  elem("btn-rapor-toggle").addEventListener("click", () => {
    const wrapper = elem("rapor-wrapper");
    const gizlendi = wrapper.classList.toggle("gizli");
    elem("btn-rapor-toggle").textContent = gizlendi ? "Rapor Göster" : "Rapor Gizle";
    if (!gizlendi) raporGoster();
  });

  const masaQ = query(collection(db, "masalar"), orderBy("sira"));
  durum.snapshotTemizle = onSnapshot(masaQ, async (snap) => {
    const masalar = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const katSnap = await getDocs(query(collection(db, "masaKategorileri"), orderBy("sira")));
    const kategoriler = katSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    masalarRenderle(masalar, kategoriler);
  });
}

function raporVeriRenderle(kayitlar, kasaMap = {}) {
  if (kayitlar.length === 0) return `<p class="bos-mesaj">Bu tarihte kayıt yok.</p>`;

  const urunler = {};
  let saatUcreti = 0;
  let duzeltme = 0;

  kayitlar.forEach(r => {
    if (r.kategori === "sure") {
      saatUcreti += (r.tutar || 0);
    } else if (r.kategori === "urun") {
      const ad = r.urunAd || "Bilinmeyen";
      if (!urunler[ad]) urunler[ad] = { miktar: 0, tutar: 0 };
      urunler[ad].miktar += (r.urunMiktar || 1);
      urunler[ad].tutar += (r.tutar || 0);
    } else if (r.kategori === "duzeltme") {
      duzeltme += (r.tutar || 0);
    } else if (!r.kategori) {
      // Eski format: tek kayıtta urunler[] dizisi ve sureUcret
      saatUcreti += (r.sureUcret || 0);
      (r.urunler || []).forEach(u => {
        const ad = u.ad || "Bilinmeyen";
        if (!urunler[ad]) urunler[ad] = { miktar: 0, tutar: 0 };
        urunler[ad].miktar += (u.miktar || 1);
        urunler[ad].tutar += ((u.miktar || 1) * (u.birimFiyat || 0));
      });
    }
  });

  let satirlar = [];
  let toplam = 0;

  if (saatUcreti > 0) {
    satirlar.push(`<div class="rapor-satir"><span>Saat Ücreti</span><span>${paraBicimlendir(saatUcreti)}</span></div>`);
    toplam += saatUcreti;
  }

  Object.entries(urunler)
    .sort((a, b) => b[1].tutar - a[1].tutar)
    .forEach(([ad, v]) => {
      satirlar.push(`<div class="rapor-satir"><span>${v.miktar}x ${ad}</span><span>${paraBicimlendir(v.tutar)}</span></div>`);
      toplam += v.tutar;
    });

  if (duzeltme !== 0) {
    satirlar.push(`<div class="rapor-satir rapor-duzeltme"><span>Düzeltme</span><span class="${duzeltme < 0 ? "negatif" : ""}">${paraBicimlendir(duzeltme)}</span></div>`);
    toplam += duzeltme;
  }

  if (satirlar.length === 0) return `<p class="bos-mesaj">Bu tarihte kayıt yok.</p>`;

  // Kasa dağılımı
  let kasaHtml = "";
  if (Object.keys(kasaMap).length > 0) {
    const kasaToplam = {};
    kayitlar.forEach(r => {
      if (!r.kasaId) return;
      if (!kasaToplam[r.kasaId]) kasaToplam[r.kasaId] = 0;
      kasaToplam[r.kasaId] += r.kategori === "duzeltme" && r.tur === "gider"
        ? -(r.tutar || 0) : (r.tutar || 0);
    });
    const kasaSatirlar = Object.entries(kasaToplam)
      .filter(([, t]) => t !== 0)
      .map(([id, tutar]) =>
        `<div class="rapor-satir rapor-kasa-satir">
          <span>${kasaMap[id] || "—"}</span>
          <span>${paraBicimlendir(tutar)}</span>
        </div>`);
    if (kasaSatirlar.length > 0) {
      kasaHtml = `<div class="rapor-kasa-baslik">Kasa Dağılımı</div>${kasaSatirlar.join("")}`;
    }
  }

  return `
    ${satirlar.join("")}
    <div class="rapor-toplam"><span>Toplam</span><span>${paraBicimlendir(toplam)}</span></div>
    ${kasaHtml}
  `;
}

function masalarRenderle(masalar, kategoriler) {
  temizleTimerlar();
  const grid = elem("masalar-grid");
  if (!grid) return;

  const gruplar = kategoriler
    .map(kat => ({ ...kat, masalar: masalar.filter(m => m.kategoriId === kat.id) }))
    .filter(g => g.masalar.length > 0);

  // Süreli kategoriler üstte, süresiz altta
  const sirali = [
    ...gruplar.filter(g => g.masalar.some(m => m.sureli)),
    ...gruplar.filter(g => g.masalar.every(m => !m.sureli)),
  ];

  if (sirali.length === 0) {
    grid.innerHTML = `<p class="bos-mesaj">Henüz masa eklenmedi. Yönetim Paneli'nden masa ekleyebilirsiniz.</p>`;
    return;
  }

  grid.innerHTML = sirali.map(grup => {
    const masalar = grup.masalar;
    return `
      <div class="kategori-grup">
        <h3 class="kategori-baslik">${grup.ad}</h3>
        <div class="masa-grid">${masalar.map(m => masaKartiHtml(m, grup.ad)).join("")}</div>
      </div>
    `;
  }).join("");

  // Süreli aktif masalarda sayaç başlat
  masalar.filter(m => m.aktif && m.sureli && m.acilisSaati).forEach(masa => {
    const ms = masa.acilisSaati.toMillis();
    const id = setInterval(() => {
      const el = elem(`sure-${masa.id}`);
      if (el) el.textContent = sureHesapla(ms);
      else clearInterval(id);
    }, 1000);
    durum.timerIdler.push(id);
  });

  // Masa kartı tıklama
  grid.querySelectorAll(".masa-kart").forEach(kart => {
    kart.addEventListener("click", () => {
      const masa = masalar.find(m => m.id === kart.dataset.id);
      if (masa) masaModalAc(masa);
    });
  });
}

function masaKartiHtml(masa, katAd = "") {
  let icerik = "";
  if (masa.aktif) {
    if (masa.sureli && masa.acilisSaati) {
      const ms = masa.acilisSaati.toMillis();
      const saatStr = new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      icerik = `
        <div class="masa-acilis">Açılış: ${saatStr}</div>
        <div class="masa-sure" id="sure-${masa.id}">${sureHesapla(ms)}</div>
      `;
    } else {
      icerik = `<div class="masa-tutar">${paraBicimlendir(masa.toplamTutar)}</div>`;
    }
  }

  let ikon = "";
  if (masa.sureli) {
    ikon = `<img src="masaicon.jpg" class="masa-kart-ikon" alt="" />`;
  } else if (katAd.toLowerCase().includes("okey")) {
    ikon = `<img src="okeyicon.jpg" class="masa-kart-ikon" alt="" />`;
  }

  return `
    <div class="masa-kart${masa.aktif ? " aktif" : ""}" data-id="${masa.id}">
      <div class="masa-kart-icerik">
        <div class="masa-ad">${masa.ad}</div>
        ${icerik}
      </div>
      ${ikon}
    </div>
  `;
}


// ============================================================
// 9. MASA MODAL
// Masaya tıklanınca açılan menü.
// Boş masa: Masa Aç / Ürün Girişi, Masa Geçmişi.
// Aktif masa: Ürün Girişi, Masa Geçmişi, Masayı Kapat.
// ============================================================

async function masaModalAc(masa) {
  elem("masa-modal")?.remove();

  // Boş süreli masa — sadece Masa Aç göster
  if (!masa.aktif && masa.sureli) {
    const modal = document.createElement("div");
    modal.id = "masa-modal";
    modal.className = "modal-arka-plan";
    modal.innerHTML = `
      <div class="modal-kutu">
        <h3>${masa.ad}</h3>
        <p class="masa-durum-etiketi">Boş</p>
        <div class="modal-butonlar">
          <button id="btn-masa-ac" class="btn-birincil">Masa Aç</button>
          <button id="btn-masa-gecmis" class="btn-ikincil">Geçmiş</button>
          <button id="btn-modal-kapat" class="btn-iptal">İptal</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener("click", e => { if (e.target === modal) modalKapat(); });
    elem("btn-modal-kapat").addEventListener("click", modalKapat);
    elem("btn-masa-gecmis").addEventListener("click", () => { modalKapat(); masaGecmisiGoster(masa); });
    elem("btn-masa-ac").addEventListener("click", () => { modalKapat(); masaAc(masa); });
    return;
  }

  // Aktif masa veya boş süresiz masa — ürün listesi göster
  const [urunSnap, kayitSnap] = await Promise.all([
    getDocs(query(collection(db, "urunler"), orderBy("sira"))),
    getDocs(query(collection(db, "masaKayitlari"), where("masaId", "==", masa.id))),
  ]);
  const urunler = urunSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  let kayitlar = kayitSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.tarih?.toMillis?.() ?? 0) - (b.tarih?.toMillis?.() ?? 0));

  let sureSatiri = "";
  if (masa.aktif && masa.sureli && masa.acilisSaati) {
    const ms = masa.acilisSaati.toMillis();
    sureSatiri = `<p class="masa-modal-sure" id="modal-sure-${masa.id}">Süre: ${sureHesapla(ms)}</p>`;
    const id = setInterval(() => {
      const el = elem(`modal-sure-${masa.id}`);
      if (el) el.textContent = `Süre: ${sureHesapla(ms)}`;
      else clearInterval(id);
    }, 1000);
    durum.timerIdler.push(id);
  }

  const urunGrid = urunler.length > 0
    ? `<div class="urun-grid">${urunler.map(u => `
        <button class="urun-btn" data-id="${u.id}" data-ad="${u.ad}" data-fiyat="${u.fiyat}">
          <span class="urun-btn-ad">${u.ad}</span>
          <span class="urun-btn-fiyat">${paraBicimlendir(u.fiyat)}</span>
        </button>`).join("")}
      </div>`
    : `<p class="bos-mesaj kucuk">Ürün tanımlanmamış. Yönetim → Ürünler bölümünden ekleyin.</p>`;

  const modal = document.createElement("div");
  modal.id = "masa-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <div class="modal-baslik-satir">
        <h3>${masa.ad}</h3>
        <span class="masa-modal-tutar-badge${masa.aktif ? "" : " gizli"}" id="modal-tutar-badge">${paraBicimlendir(masa.toplamTutar)}</span>
      </div>
      ${sureSatiri}
      ${urunGrid}
      <div id="modal-pending-alan"></div>
      <div id="modal-sepet"></div>
      <div class="modal-butonlar" style="margin-top:12px">
        ${masa.aktif ? `<button id="btn-masa-kapat" class="btn-kapat">Masayı Kapat</button>` : ""}
        <button id="btn-masa-gecmis" class="btn-ikincil">Geçmiş</button>
        <button id="btn-modal-kapat" class="btn-iptal">Kapat</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  let pending = [];

  const sepetYenile = async () => {
    const snap = await getDocs(query(collection(db, "masaKayitlari"), where("masaId", "==", masa.id)));
    kayitlar = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.tarih?.toMillis?.() ?? 0) - (b.tarih?.toMillis?.() ?? 0));
    modalSepetGuncelle(kayitlar, masa, silKayit);
  };

  const silKayit = async (kayitId) => {
    const kayit = kayitlar.find(k => k.id === kayitId);
    if (!kayit) return;
    if (kayit.miktar > 1) {
      await updateDoc(doc(db, "masaKayitlari", kayitId), {
        miktar: kayit.miktar - 1,
        tutar: (kayit.miktar - 1) * kayit.birimFiyat,
      });
    } else {
      await deleteDoc(doc(db, "masaKayitlari", kayitId));
    }
    masa.toplamTutar = Math.max(0, (masa.toplamTutar || 0) - kayit.birimFiyat);
    await updateDoc(doc(db, "masalar", masa.id), { toplamTutar: masa.toplamTutar });
    const badge = elem("modal-tutar-badge");
    if (badge) badge.textContent = paraBicimlendir(masa.toplamTutar);
    await sepetYenile();
  };

  const renderPending = () => {
    const el = elem("modal-pending-alan");
    if (!el) return;
    if (pending.length === 0) { el.innerHTML = ""; return; }

    const gruplu = {};
    pending.forEach(p => {
      if (!gruplu[p.ad]) gruplu[p.ad] = { ad: p.ad, fiyat: p.fiyat, adet: 0 };
      gruplu[p.ad].adet++;
    });
    const pendingToplam = pending.reduce((t, p) => t + p.fiyat, 0);

    el.innerHTML = `
      <div class="modal-pending">
        <div class="pending-chips">
          ${Object.values(gruplu).map(g =>
            `<span class="pending-chip">${g.ad}${g.adet > 1 ? ` ×${g.adet}` : ""}</span>`
          ).join("")}
        </div>
        <div class="pending-butonlar">
          <button id="btn-geri-al" class="btn-ikincil btn-kucuk">← Geri Al</button>
          <button id="btn-onayla" class="btn-birincil btn-kucuk">Ekle (${paraBicimlendir(pendingToplam)})</button>
        </div>
      </div>
    `;

    elem("btn-geri-al").addEventListener("click", () => { pending.pop(); renderPending(); });
    elem("btn-onayla").addEventListener("click", async () => {
      elem("btn-onayla").disabled = true;
      await pendingOnayla();
    });
  };

  const pendingOnayla = async () => {
    if (pending.length === 0) return;
    const gruplu = {};
    pending.forEach(p => {
      if (!gruplu[p.ad]) gruplu[p.ad] = { ad: p.ad, fiyat: p.fiyat, adet: 0 };
      gruplu[p.ad].adet++;
    });

    let eklenecekToplam = 0;
    for (const g of Object.values(gruplu)) {
      const mevcutKayit = kayitlar.find(k => k.ad === g.ad);
      const eklenecek = g.adet * g.fiyat;
      eklenecekToplam += eklenecek;
      if (mevcutKayit) {
        const yeniMiktar = mevcutKayit.miktar + g.adet;
        await updateDoc(doc(db, "masaKayitlari", mevcutKayit.id), {
          miktar: yeniMiktar, tutar: yeniMiktar * mevcutKayit.birimFiyat,
        });
      } else {
        await addDoc(collection(db, "masaKayitlari"), {
          masaId: masa.id, ad: g.ad, miktar: g.adet, birimFiyat: g.fiyat, tutar: eklenecek,
          tarih: serverTimestamp(),
        });
      }
    }

    masa.toplamTutar = (masa.toplamTutar || 0) + eklenecekToplam;
    masa.aktif = true;
    await updateDoc(doc(db, "masalar", masa.id), { aktif: true, toplamTutar: masa.toplamTutar });

    const badge = elem("modal-tutar-badge");
    if (badge) { badge.textContent = paraBicimlendir(masa.toplamTutar); badge.classList.remove("gizli"); }

    if (!elem("btn-masa-kapat")) {
      const butonlar = modal.querySelector(".modal-butonlar");
      const kapBtn = document.createElement("button");
      kapBtn.id = "btn-masa-kapat";
      kapBtn.className = "btn-kapat";
      kapBtn.textContent = "Masayı Kapat";
      butonlar.insertBefore(kapBtn, butonlar.firstChild);
      kapBtn.addEventListener("click", () => { modalKapat(); odemeEkraniAc(masa); });
    }

    pending = [];
    renderPending();
    await sepetYenile();
  };

  modalSepetGuncelle(kayitlar, masa, silKayit);

  modal.addEventListener("click", e => { if (e.target === modal) modalKapat(); });
  elem("btn-modal-kapat").addEventListener("click", modalKapat);
  elem("btn-masa-gecmis").addEventListener("click", () => { modalKapat(); masaGecmisiGoster(masa); });
  elem("btn-masa-kapat")?.addEventListener("click", () => { modalKapat(); odemeEkraniAc(masa); });

  // Ürün butonuna tıkla → pending'e ekle, henüz kaydetme
  modal.querySelectorAll(".urun-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      pending.push({ ad: btn.dataset.ad, fiyat: parseFloat(btn.dataset.fiyat) });
      renderPending();
    });
  });
}

function modalSepetGuncelle(kayitlar, masa, onSil) {
  const el = elem("modal-sepet");
  if (!el) return;
  if (kayitlar.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="modal-sepet">
      ${kayitlar.map(k => `
        <div class="modal-sepet-satir">
          <span>${k.ad}${k.miktar > 1 ? ` × ${k.miktar}` : ""}</span>
          <div class="modal-sepet-sag">
            <span class="modal-sepet-tutar">${paraBicimlendir(k.tutar)}</span>
            <button class="btn-sepet-sil" data-id="${k.id}">✕</button>
          </div>
        </div>`).join("")}
    </div>
  `;
  if (onSil) {
    el.querySelectorAll(".btn-sepet-sil").forEach(btn => {
      btn.addEventListener("click", () => onSil(btn.dataset.id));
    });
  }
}

async function masaAc(masa) {
  await updateDoc(doc(db, "masalar", masa.id), {
    aktif: true, acilisSaati: serverTimestamp(), toplamTutar: 0,
  });
}

async function masaGecmisiGoster(masa) {
  elem("gecmis-modal")?.remove();
  const isAdmin = durum.kullanici?.rol === "admin";
  let filtre = "bugun";

  const kasaSnap = await getDocs(collection(db, "kasalar"));
  const kasaMap = {};
  kasaSnap.docs.forEach(d => { kasaMap[d.id] = { id: d.id, ...d.data() }; });

  const hareketleriYukle = async () => {
    const snap = await getDocs(query(
      collection(db, "kasaHareketleri"),
      where("masaId", "==", masa.id)
    ));
    let basTarihMs;
    if (filtre === "son7") {
      const d = new Date();
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      d.setDate(d.getDate() - 6);
      d.setHours(6, 0, 0, 0);
      basTarihMs = d.getTime();
    } else {
      basTarihMs = bugunBaslangic().toMillis();
    }
    const records = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(h => h.tarih && h.tarih.toMillis() >= basTarihMs);

    // Kayıtları oturumId'ye göre grupla
    const oturumMap = {};
    records.forEach(r => {
      const key = r.oturumId ?? r.id; // eski format için id'yi key olarak kullan
      if (!oturumMap[key]) oturumMap[key] = [];
      oturumMap[key].push(r);
    });

    return Object.values(oturumMap).map(kayitlar => {
      const ilk = kayitlar[0];

      // Eski format: tek kayıt, içinde urunler[] dizisi var
      if (kayitlar.length === 1 && ilk.urunler) {
        return {
          _kayitIds: [ilk.id], kasaId: ilk.kasaId, tarih: ilk.tarih,
          kasaAd: kasaMap[ilk.kasaId]?.ad || "—",
          kasaTip: kasaMap[ilk.kasaId]?.tip || null,
          acilisSaati: ilk.acilisSaati, sureli: ilk.sureli,
          sureUcret: ilk.sureUcret || 0, urunler: ilk.urunler || [],
          urunToplam: ilk.urunToplam || 0,
          hesaplananTutar: ilk.hesaplananTutar ?? ilk.tutar,
          tutar: ilk.tutar,
          oyuncuId: ilk.oyuncuId || null,
          oyuncuAd: ilk.oyuncuAd || null,
        };
      }

      // Yeni format: birden fazla kayıt, oturumId ile gruplandı
      const sureKayit   = kayitlar.find(r => r.kategori === "sure");
      const urunKayitlar = kayitlar.filter(r => r.kategori === "urun");
      const duzeltme    = kayitlar.find(r => r.kategori === "duzeltme");

      const sureUcret  = sureKayit?.tutar || 0;
      const urunler    = urunKayitlar.map(r => ({
        ad: r.urunAd, miktar: r.urunMiktar,
        birimFiyat: r.urunBirimFiyat, tutar: r.tutar,
      }));
      const urunToplam     = urunler.reduce((t, u) => t + u.tutar, 0);
      const hesaplananTutar = sureUcret + urunToplam;
      const fark = duzeltme ? (duzeltme.tur === "gelir" ? duzeltme.tutar : -duzeltme.tutar) : 0;

      const enSonTarih = kayitlar.reduce((en, r) =>
        r.tarih.toMillis() > en.toMillis() ? r.tarih : en, kayitlar[0].tarih);

      return {
        _kayitIds: kayitlar.map(r => r.id),
        kasaId: ilk.kasaId, tarih: enSonTarih,
        kasaAd: kasaMap[ilk.kasaId]?.ad || "—",
        kasaTip: kasaMap[ilk.kasaId]?.tip || null,
        acilisSaati: ilk.acilisSaati, sureli: ilk.sureli,
        sureUcret, urunler, urunToplam, hesaplananTutar,
        tutar: hesaplananTutar + fark,
        oyuncuId: ilk.oyuncuId || null,
        oyuncuAd: ilk.oyuncuAd || null,
      };
    }).sort((a, b) => b.tarih.toMillis() - a.tarih.toMillis());
  };

  const listeYenile = async () => {
    const hareketler = await hareketleriYukle();
    const liste = elem("gecmis-liste-icerik");
    if (!liste) return;

    if (hareketler.length === 0) {
      liste.innerHTML = `<p class="bos-mesaj">Bu masa için geçmiş kayıt bulunamadı.</p>`;
      return;
    }

    const genelToplam = hareketler.reduce((t, h) => t + (h.hesaplananTutar ?? h.tutar), 0);

    liste.innerHTML = hareketler.map(h => {
      const kapanisDt = h.tarih.toDate();
      const kapanisStr = kapanisDt.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
      const tarihStr = kapanisDt.toLocaleDateString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric" });

      let zamanSatiri = `${tarihStr} · Kapanış: ${kapanisStr}`;
      if (h.acilisSaati) {
        const acilisStr = h.acilisSaati.toDate().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
        zamanSatiri = `${tarihStr} · Açılış: ${acilisStr} · Kapanış: ${kapanisStr}`;
        if (h.sureli) {
          const toplamSn = Math.floor((h.tarih.toMillis() - h.acilisSaati.toMillis()) / 1000);
          const saat = Math.floor(toplamSn / 3600);
          const dakika = Math.floor((toplamSn % 3600) / 60);
          const sureStr = `${saat > 0 ? saat + "sa " : ""}${dakika}dk`;
          zamanSatiri += ` · <span class="gecmis-sure">Süre: ${sureStr}</span>`;
        }
      }

      const kasaBadge = `<span class="gecmis-kasa-badge">${h.kasaAd || "—"}</span>`;
      const oyuncuBadge = h.kasaTip === "veresiye" && h.oyuncuAd
        ? ` <span class="gecmis-oyuncu-badge">${h.oyuncuAd}</span>` : "";

      // Ücret dökümü
      const satirlar = [];
      if (h.sureli && h.sureUcret > 0) {
        satirlar.push(`<div class="gecmis-dokim-satir">
          <span>Süre Ücreti</span><span>${paraBicimlendir(h.sureUcret)}</span>
        </div>`);
      }
      if (h.urunler && h.urunler.length > 0) {
        h.urunler.forEach(u => {
          satirlar.push(`<div class="gecmis-dokim-satir">
            <span>${u.ad}${u.miktar > 1 ? ` ×${u.miktar}` : ""}</span>
            <span>${paraBicimlendir(u.tutar)}</span>
          </div>`);
        });
        if (h.urunToplam > 0) {
          satirlar.push(`<div class="gecmis-dokim-satir gecmis-ara-toplam">
            <span>Ürünler Toplamı</span><span>${paraBicimlendir(h.urunToplam)}</span>
          </div>`);
        }
      }
      const dokumHtml = satirlar.length > 0
        ? `<div class="gecmis-dokim">${satirlar.join("")}</div>` : "";

      const toplamFarki = h.tutar !== h.hesaplananTutar
        ? `<div class="gecmis-dokim-satir gecmis-alinan">
            <span>Alınan</span><span>${paraBicimlendir(h.tutar)}</span>
          </div>` : "";

      return `
        <div class="gecmis-satir">
          <div class="gecmis-bilgi">
            <div class="gecmis-zamanlar">${zamanSatiri}</div>
            <div class="gecmis-meta">${kasaBadge}${oyuncuBadge}</div>
            ${dokumHtml}
            ${toplamFarki}
          </div>
          <div class="gecmis-sag">
            <span class="gecmis-tutar">${paraBicimlendir(h.hesaplananTutar ?? h.tutar)}</span>
            ${isAdmin ? `<button class="btn-gecmis-sil"
              data-ids='${JSON.stringify(h._kayitIds)}'
              data-kasa="${h.kasaId}"
              data-tutar="${h.tutar}"
              data-oyuncu-id="${h.oyuncuId || ''}"
              data-oyuncu-tutar="${h.hesaplananTutar ?? h.tutar}">Sil</button>` : ""}
          </div>
        </div>
      `;
    }).join("") + `
      <div class="gecmis-genel-toplam">
        <span>Genel Toplam</span>
        <span>${paraBicimlendir(genelToplam)}</span>
      </div>`;

    if (isAdmin) {
      liste.querySelectorAll(".btn-gecmis-sil").forEach(btn => {
        btn.addEventListener("click", async () => {
          if (!confirm("Bu kayıt silinecek ve kasa bakiyesi düşecek. Emin misiniz?")) return;
          btn.disabled = true;
          const kasaRef = doc(db, "kasalar", btn.dataset.kasa);
          const kasaSnap = await getDoc(kasaRef);
          const mevcutBakiye = kasaSnap.data()?.bakiye || 0;
          await updateDoc(kasaRef, { bakiye: Math.max(0, mevcutBakiye - parseFloat(btn.dataset.tutar)) });
          const ids = JSON.parse(btn.dataset.ids);
          await Promise.all(ids.map(id => deleteDoc(doc(db, "kasaHareketleri", id))));
          if (btn.dataset.oyuncuId) {
            await updateDoc(doc(db, "kullanicilar", btn.dataset.oyuncuId), {
              veresiye: increment(-parseFloat(btn.dataset.oyuncuTutar)),
            });
          }
          await listeYenile();
        });
      });
    }
  };

  const modal = document.createElement("div");
  modal.id = "gecmis-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${masa.ad} — Geçmiş</h3>
      ${isAdmin ? `
      <div class="gecmis-filtre-bant">
        <button class="gecmis-filtre-btn aktif" data-filtre="bugun">Bugün</button>
        <button class="gecmis-filtre-btn" data-filtre="son7">Son 7 Gün</button>
      </div>` : ""}
      <div class="gecmis-liste" id="gecmis-liste-icerik">Yükleniyor...</div>
      <div class="modal-butonlar" style="margin-top:16px">
        <button id="btn-gecmis-kapat" class="btn-iptal">Kapat</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-gecmis-kapat").addEventListener("click", () => modal.remove());

  if (isAdmin) {
    modal.querySelectorAll(".gecmis-filtre-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        filtre = btn.dataset.filtre;
        modal.querySelectorAll(".gecmis-filtre-btn").forEach(b => b.classList.toggle("aktif", b === btn));
        listeYenile();
      });
    });
  }

  await listeYenile();
}


// ============================================================
// 10. ÖDEME EKRANI
// Masayı kapatırken açılır. Hesaplanan toplam tutarı gösterir,
// alınan tutarı ve kasa seçimini alır, onaylanınca masayı
// kapatır ve hareketi kasaya işler.
// ============================================================

async function odemeEkraniAc(masa) {
  const [kasaSnap, kayitSnap, oyuncuSnap] = await Promise.all([
    getDocs(query(collection(db, "kasalar"), orderBy("sira"))),
    getDocs(query(collection(db, "masaKayitlari"), where("masaId", "==", masa.id))),
    getDocs(collection(db, "kullanicilar")),
  ]);
  const kasalar = kasaSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const kayitlar = kayitSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const oyuncular = oyuncuSnap.docs
    .filter(d => d.data().rol === "oyuncu")
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.adSoyad || "").localeCompare(b.adSoyad || "", "tr"));

  const acilisMs = masa.acilisSaati ? masa.acilisSaati.toMillis() : null;
  const sureUcret = masa.sureli && acilisMs ? sureUcretiHesapla(acilisMs, masa.saatlikUcret || 0) : 0;
  const urunToplam = kayitlar.reduce((t, k) => t + (k.tutar || 0), 0);
  const genelToplam = sureUcret + urunToplam;

  const urunlerHtml = kayitlar.length > 0
    ? kayitlar.map(k => `
        <div class="odeme-satir odeme-satir-urun">
          <span>${k.ad}${k.miktar > 1 ? ` ×${k.miktar}` : ""}</span>
          <span>${paraBicimlendir(k.tutar)}</span>
        </div>`).join("") +
      `<div class="odeme-satir odeme-ara-toplam">
        <span>Ürünler Toplamı</span>
        <span>${paraBicimlendir(urunToplam)}</span>
      </div>`
    : "";

  const kasaSecenekleri = kasalar.map(k => `<option value="${k.id}" data-tip="${k.tip || ""}">${k.ad}</option>`).join("");

  const modal = document.createElement("div");
  modal.id = "odeme-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${masa.ad} — Ödeme</h3>
      <div class="odeme-ozet">
        ${masa.sureli ? `<div class="odeme-satir"><span>Süre Ücreti</span><span>${paraBicimlendir(sureUcret)}</span></div>` : ""}
        ${urunlerHtml}
        <div class="odeme-satir toplam"><span>Toplam</span><span>${paraBicimlendir(genelToplam)}</span></div>
      </div>
      <form id="odeme-form">
        <label>Alınan Tutar <small>(boş bırakılırsa tam tutar alındı sayılır)</small></label>
        <input type="number" id="alinan-tutar" placeholder="${genelToplam.toFixed(2)}" min="0" step="0.01" />
        <label>Kasa</label>
        <select id="kasa-secimi">${kasaSecenekleri}</select>
        <div id="oyuncu-secim-blok" class="gizli">
          <label>Oyuncu</label>
          <input type="text" id="oyuncu-ara" placeholder="İsim ile ara…" autocomplete="off" />
          <div class="oyuncu-secim-liste" id="oyuncu-secim-liste"></div>
          <div id="veresiye-ozet" class="veresiye-ozet gizli"></div>
        </div>
        <label>Açıklama <small>(isteğe bağlı)</small></label>
        <input type="text" id="odeme-aciklama" />
        <p id="odeme-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Onayla ve Kapat</button>
          <button type="button" id="btn-odeme-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-odeme-iptal").addEventListener("click", () => modal.remove());

  let seciliOyuncu = null;

  function oyuncuListesiRender(filtre) {
    const liste = elem("oyuncu-secim-liste");
    const aramaKucuk = (filtre || "").toLowerCase();
    const gorunenler = oyuncular.filter(o =>
      !aramaKucuk || (o.adSoyad || "").toLowerCase().includes(aramaKucuk)
    );
    liste.innerHTML = gorunenler.length
      ? gorunenler.map(o => `
          <div class="oyuncu-secim-satir${seciliOyuncu?.id === o.id ? " secili" : ""}" data-id="${o.id}">
            <span class="oyss-ad">${o.adSoyad || o.kullaniciAdi}</span>
            <span class="oyss-bakiye${(o.veresiye || 0) > 0 ? " negatif" : ""}">${paraBicimlendir(o.veresiye || 0)}</span>
          </div>`).join("")
      : `<p class="bos-mesaj">Oyuncu bulunamadı.</p>`;

    liste.querySelectorAll(".oyuncu-secim-satir").forEach(satir => {
      satir.addEventListener("click", () => {
        seciliOyuncu = oyuncular.find(o => o.id === satir.dataset.id) || null;
        oyuncuListesiRender(elem("oyuncu-ara").value);
        veresiyeOzetGuncelle();
      });
    });
  }

  function veresiyeOzetGuncelle() {
    const ozetEl = elem("veresiye-ozet");
    if (!seciliOyuncu) { ozetEl.classList.add("gizli"); return; }
    const mevcut = seciliOyuncu.veresiye || 0;
    const yeni = mevcut + genelToplam;
    ozetEl.classList.remove("gizli");
    ozetEl.innerHTML = `
      <div class="veresiye-ozet-satir">
        <span>Mevcut Bakiye</span>
        <span class="${mevcut > 0 ? "negatif" : ""}">${paraBicimlendir(mevcut)}</span>
      </div>
      <div class="veresiye-ozet-satir">
        <span>Bu İşlem</span>
        <span class="negatif">+${paraBicimlendir(genelToplam)}</span>
      </div>
      <div class="veresiye-ozet-satir veresiye-ozet-toplam">
        <span>Yeni Bakiye</span>
        <span class="negatif">${paraBicimlendir(yeni)}</span>
      </div>`;
  }

  function kasaDegistiKontrol() {
    const select = elem("kasa-secimi");
    const tip = select.options[select.selectedIndex]?.dataset.tip;
    const blok = elem("oyuncu-secim-blok");
    if (tip === "veresiye") {
      blok.classList.remove("gizli");
      oyuncuListesiRender(elem("oyuncu-ara").value);
    } else {
      blok.classList.add("gizli");
      seciliOyuncu = null;
    }
  }

  elem("kasa-secimi").addEventListener("change", kasaDegistiKontrol);
  elem("oyuncu-ara").addEventListener("input", () => oyuncuListesiRender(elem("oyuncu-ara").value));
  kasaDegistiKontrol();

  elem("odeme-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const hataEl = elem("odeme-hata");
    hataEl.classList.add("gizli");
    const alinanRaw = elem("alinan-tutar").value;
    const alinanTutar = alinanRaw ? parseFloat(alinanRaw) : genelToplam;
    const kasaId = elem("kasa-secimi").value;
    const kasaTip = elem("kasa-secimi").options[elem("kasa-secimi").selectedIndex]?.dataset.tip;
    const aciklama = elem("odeme-aciklama").value.trim();
    const btn = e.target.querySelector("[type='submit']");

    if (kasaTip === "veresiye" && !seciliOyuncu) {
      hataEl.textContent = "Veresiye için lütfen bir oyuncu seçin.";
      hataEl.classList.remove("gizli");
      return;
    }

    btn.disabled = true;
    try {
      await masayiKapat(masa, genelToplam, alinanTutar, kasaId, aciklama, sureUcret,
        kasaTip === "veresiye" ? seciliOyuncu.id : null,
        kasaTip === "veresiye" ? (seciliOyuncu.adSoyad || seciliOyuncu.kullaniciAdi) : null);
      if (kasaTip === "veresiye" && seciliOyuncu) {
        await updateDoc(doc(db, "kullanicilar", seciliOyuncu.id), {
          veresiye: increment(genelToplam),
        });
      }
      modal.remove();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

async function masayiKapat(masa, hesaplananTutar, alinanTutar, kasaId, aciklama, sureUcret = 0, oyuncuId = null, oyuncuAd = null) {
  const kayitSnap = await getDocs(query(collection(db, "masaKayitlari"), where("masaId", "==", masa.id)));
  const urunler = kayitSnap.docs.map(d => {
    const v = d.data();
    return { ad: v.ad, miktar: v.miktar, birimFiyat: v.birimFiyat, tutar: v.tutar };
  });
  await Promise.all(kayitSnap.docs.map(d => deleteDoc(doc(db, "masaKayitlari", d.id))));

  await updateDoc(doc(db, "masalar", masa.id), {
    aktif: false, acilisSaati: null, toplamTutar: 0,
  });

  // Her kategori ayrı kayıt — analiz için
  const oturumId = `${masa.id}_${Date.now()}`;
  const ortak = {
    kasaId, masaId: masa.id, tur: "gelir",
    oturumId, sureli: masa.sureli || false,
    acilisSaati: masa.acilisSaati || null,
    tarih: serverTimestamp(),
    ...(oyuncuId ? { oyuncuId, oyuncuAd } : {}),
  };

  const yazilacaklar = [];

  if (sureUcret > 0) {
    yazilacaklar.push({ ...ortak, tutar: sureUcret,
      aciklama: `${masa.ad} - Süre Ücreti`, kategori: "sure" });
  }
  for (const u of urunler) {
    if ((u.tutar || 0) > 0) {
      yazilacaklar.push({ ...ortak, tutar: u.tutar,
        aciklama: `${masa.ad} - ${u.ad}`, kategori: "urun",
        urunAd: u.ad, urunMiktar: u.miktar, urunBirimFiyat: u.birimFiyat });
    }
  }
  if (yazilacaklar.length === 0) {
    yazilacaklar.push({ ...ortak, tutar: alinanTutar,
      aciklama: aciklama || `${masa.ad} - masa ödemesi`, kategori: "ozet" });
  }
  const fark = Math.round((alinanTutar - hesaplananTutar) * 100) / 100;
  if (Math.abs(fark) > 0.01) {
    yazilacaklar.push({ ...ortak, tutar: Math.abs(fark),
      tur: fark > 0 ? "gelir" : "gider",
      aciklama: `${masa.ad} - ${fark > 0 ? "Fazla Ödeme" : "İndirim"}`,
      kategori: "duzeltme" });
  }

  await Promise.all(yazilacaklar.map(v => addDoc(collection(db, "kasaHareketleri"), v)));

  const kasaRef = doc(db, "kasalar", kasaId);
  const kasaSnap = await getDoc(kasaRef);
  await updateDoc(kasaRef, { bakiye: (kasaSnap.data()?.bakiye || 0) + alinanTutar });
}


// ============================================================
// 11. KASALAR SAYFASI
// Tüm kasaları alt alta listeler. Her kartta toplam bakiye,
// bugünün geliri, gideri ve net sonucu gösterilir.
// Veresiye kasasında tahsilat ve yazılan veresiye ayrı gösterilir.
// ============================================================

async function kasalarSayfasi(kapsayici) {
  kapsayici.innerHTML = `
    <div class="sayfa-baslik"><h2>Kasalar</h2></div>
    <div id="kasalar-liste">Yükleniyor...</div>
    <button id="kasa-rapor-toggle" class="btn-rapor-toggle">Rapor Göster</button>
    <div id="kasa-rapor-bolum" class="gizli"></div>
  `;

  const [kasaSnap, hareketSnap] = await Promise.all([
    getDocs(query(collection(db, "kasalar"), orderBy("sira"))),
    getDocs(collection(db, "kasaHareketleri")),
  ]);

  const bugunMs = bugunBaslangic().toMillis();
  const kasalar = kasaSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const kasaMap = {};
  kasalar.forEach(k => { kasaMap[k.id] = k; });

  const hareketler = hareketSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(h => h.tarih && h.tarih.toMillis() >= bugunMs);

  const liste = elem("kasalar-liste");
  liste.innerHTML = kasalar.map(k => kasaKartiHtml(k, hareketler)).join("");

  liste.querySelectorAll(".kasa-kart").forEach(kart => {
    kart.addEventListener("click", () => {
      const kasa = kasalar.find(k => k.id === kart.dataset.id);
      if (kasa) kasaDetayAc(kapsayici, kasa);
    });
  });

  // Tarih aralığı raporu
  const bugunStr = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  })();

  const raporBolum = elem("kasa-rapor-bolum");
  raporBolum.innerHTML = `
    <div class="kr-kapsayici">
      <div class="kr-baslik">Tarih Aralığı Raporu</div>
      <div class="kr-tarih-satir">
        <div class="kr-tarih-grup">
          <label>Başlangıç</label>
          <input type="date" id="kr-baslangic" value="${bugunStr}" />
        </div>
        <div class="kr-tarih-grup">
          <label>Bitiş</label>
          <input type="date" id="kr-bitis" value="${bugunStr}" />
        </div>
      </div>
      <div class="kr-filtreler">
        <div class="kr-filtre-grup">
          <div class="kr-filtre-baslik">Kasalar</div>
          <div class="kr-check-listesi">
            ${kasalar.map(k => `
              <label class="kr-check-satir">
                <input type="checkbox" class="kr-kasa-cb" value="${k.id}" checked />
                ${k.ad}
              </label>
            `).join("")}
          </div>
        </div>
        <div class="kr-filtre-grup">
          <div class="kr-filtre-baslik">İşlem Türü</div>
          <div class="kr-check-listesi">
            ${TUR_LISTESI.map(t => `
              <label class="kr-check-satir">
                <input type="checkbox" class="kr-tur-cb" value="${t.id}" checked />
                ${t.etiket}
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="kr-eylem-satir">
        <button id="kr-listele" class="btn-birincil">Listele</button>
        <button id="kr-excel" class="btn-ikincil btn-kucuk gizli">Excel</button>
      </div>
      <div id="kr-sonuc"></div>
    </div>
  `;

  let sonHareketler = [];

  elem("kr-listele").addEventListener("click", async () => {
    const baslangicStr = elem("kr-baslangic").value;
    const bitisStr     = elem("kr-bitis").value;
    if (!baslangicStr || !bitisStr) return;

    const baslangic = Timestamp.fromDate(new Date(baslangicStr + "T00:00:00"));
    const bitis     = Timestamp.fromDate(new Date(bitisStr     + "T23:59:59"));

    const seciliKasalar = [...raporBolum.querySelectorAll(".kr-kasa-cb:checked")].map(cb => cb.value);
    const seciliTurler  = [...raporBolum.querySelectorAll(".kr-tur-cb:checked")].map(cb => cb.value);

    const btn = elem("kr-listele");
    btn.textContent = "Yükleniyor…";
    btn.disabled = true;

    try {
      const snap = await getDocs(query(
        collection(db, "kasaHareketleri"),
        where("tarih", ">=", baslangic),
        where("tarih", "<=", bitis),
        orderBy("tarih"),
      ));
      const filtreli = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(h => seciliKasalar.includes(h.kasaId) && seciliTurler.includes(h.tur));

      sonHareketler = filtreli;
      kasaRaporuRenderle(filtreli, kasaMap, elem("kr-sonuc"));
      elem("kr-excel").classList.remove("gizli");
    } finally {
      btn.textContent = "Listele";
      btn.disabled = false;
    }
  });

  elem("kr-excel").addEventListener("click", () => {
    kasaRaporuXlsx(sonHareketler, kasaMap);
  });

  elem("kasa-rapor-toggle").addEventListener("click", () => {
    const gizlendi = raporBolum.classList.toggle("gizli");
    elem("kasa-rapor-toggle").textContent = gizlendi ? "Rapor Göster" : "Rapor Gizle";
  });
}

function kasaKartiHtml(kasa, hareketler) {
  const h = hareketler.filter(x => x.kasaId === kasa.id);
  const gelir = h.filter(x => x.tur === "gelir").reduce((t, x) => t + x.tutar, 0);
  const gider = h.filter(x => x.tur === "gider").reduce((t, x) => t + x.tutar, 0);
  const net = gelir - gider;
  const netClass = net > 0 ? "pozitif" : net < 0 ? "negatif" : "sifir";

  if (kasa.tip === "veresiye") {
    const tahsilat = h.filter(x => x.tur === "tahsilat").reduce((t, x) => t + x.tutar, 0);
    return `
      <div class="kasa-kart" data-id="${kasa.id}">
        <div class="kasa-kart-baslik">${kasa.ad}</div>
        <div class="kasa-bakiye">${paraBicimlendir(kasa.bakiye)}</div>
        <div class="kasa-istatistik">
          <span class="tahsilat-renk">Tahsilat: ${paraBicimlendir(tahsilat)}</span>
          <span class="negatif">Veresiye: ${paraBicimlendir(gelir)}</span>
        </div>
      </div>
    `;
  }

  const tahsilat = h.filter(x => x.tur === "tahsilat").reduce((t, x) => t + x.tutar, 0);
  const netToplam = gelir + tahsilat - gider;
  const netToplamClass = netToplam > 0 ? "pozitif" : netToplam < 0 ? "negatif" : "sifir";

  return `
    <div class="kasa-kart" data-id="${kasa.id}">
      <div class="kasa-kart-baslik">${kasa.ad}</div>
      <div class="kasa-bakiye">${paraBicimlendir(kasa.bakiye)}</div>
      <div class="kasa-istatistik">
        <span class="pozitif">Gelir: ${paraBicimlendir(gelir)}</span>
        <span class="tahsilat-renk">Tahsilat: ${paraBicimlendir(tahsilat)}</span>
        <span class="negatif">Gider: ${paraBicimlendir(gider)}</span>
        <span class="${netToplamClass}">Net: ${paraBicimlendir(netToplam)}</span>
      </div>
    </div>
  `;
}


function kasaRaporuRenderle(hareketler, kasaMap, hedef) {
  if (hareketler.length === 0) {
    hedef.innerHTML = `<p class="bos-mesaj" style="margin-top:12px">Seçilen kriterlere uygun hareket bulunamadı.</p>`;
    return;
  }

  const kasaToplam = {};
  const turToplam  = {};
  let genelToplam  = 0;

  hareketler.forEach(h => {
    const t = h.tutar || 0;
    kasaToplam[h.kasaId] = (kasaToplam[h.kasaId] || 0) + t;
    turToplam[h.tur]     = (turToplam[h.tur]     || 0) + t;
    genelToplam += t;
  });

  hedef.innerHTML = `
    <div class="kr-tablo-kapsayici">
      <table class="kr-tablo">
        <thead>
          <tr>
            <th>Tarih</th>
            <th>Kasa</th>
            <th>Tür</th>
            <th>Açıklama</th>
            <th class="kr-tutar-th">Tutar</th>
          </tr>
        </thead>
        <tbody>
          ${hareketler.map(h => {
            const dt = h.tarih?.toDate?.();
            const tarihStr = formatTarihSaat(dt);
            const kasaAd   = kasaMap[h.kasaId]?.ad || "—";
            const turEt    = TUR_LISTESI.find(t => t.id === h.tur)?.etiket || h.tur;
            const pozitif  = ["gelir","tahsilat","transfer_giris"].includes(h.tur);
            return `<tr>
              <td class="tarih-saat-hucre">${tarihStr}</td>
              <td>${kasaAd}</td>
              <td>${turEt}</td>
              <td>${h.aciklama || "—"}</td>
              <td class="kr-tutar-td ${pozitif ? "pozitif" : "negatif"}">${paraBicimlendir(h.tutar || 0)}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    <div class="kr-ozet-alani">
      <div class="kr-ozet-grup">
        <div class="kr-ozet-baslik">Kasa Bazlı</div>
        ${Object.entries(kasaToplam).map(([kasaId, toplam]) => `
          <div class="kr-ozet-satir">
            <span>${kasaMap[kasaId]?.ad || kasaId}</span>
            <span>${paraBicimlendir(toplam)}</span>
          </div>
        `).join("")}
      </div>
      <div class="kr-ozet-grup">
        <div class="kr-ozet-baslik">Tür Bazlı</div>
        ${Object.entries(turToplam).map(([tur, toplam]) => {
          const etiket = TUR_LISTESI.find(t => t.id === tur)?.etiket || tur;
          return `<div class="kr-ozet-satir">
            <span>${etiket}</span>
            <span>${paraBicimlendir(toplam)}</span>
          </div>`;
        }).join("")}
      </div>
    </div>
    <div class="kr-genel-toplam">
      <span>Genel Toplam</span>
      <span>${paraBicimlendir(genelToplam)}</span>
    </div>
  `;
}

function kasaRaporuXlsx(hareketler, kasaMap) {
  const satirlar = hareketler.map(h => {
    const dt = h.tarih?.toDate?.();
    return {
      "Tarih":     formatTarihSaat(dt),
      "Kasa":      kasaMap[h.kasaId]?.ad || h.kasaId || "",
      "Tür":       TUR_LISTESI.find(t => t.id === h.tur)?.etiket || h.tur || "",
      "Açıklama":  h.aciklama || "",
      "Tutar":     h.tutar || 0,
    };
  });

  const ws = window.XLSX.utils.json_to_sheet(satirlar);
  ws["!cols"] = [{ wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 32 }, { wch: 12 }];
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Rapor");
  const tarih = new Date();
  const dosyaAd = `kasa-raporu-${tarih.getFullYear()}${String(tarih.getMonth()+1).padStart(2,"0")}${String(tarih.getDate()).padStart(2,"0")}.xlsx`;
  window.XLSX.writeFile(wb, dosyaAd);
}


// ============================================================
// 12. KASA DETAY
// Tıklanan kasanın kartını üstte gösterir; altında o güne ait
// hareketleri (saat, tür, açıklama, tutar) listeler.
// ============================================================

async function kasaDetayAc(kapsayici, kasa) {
  const kasaIslemleri = kasa.tip !== "veresiye";
  const kasaVeresiye  = kasa.tip === "veresiye";
  let filtre = "bugun";

  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <button id="btn-geri" class="btn-geri">← Kasalar</button>
      <h2>${kasa.ad}</h2>
    </div>
    ${kasaIslemleri ? `
    <div class="kasa-islem-butonlar">
      <button class="btn-birincil btn-kucuk" id="btn-gelir-ekle">+ Gelir</button>
      <button class="btn-ikincil btn-kucuk" id="btn-gider-ekle">− Gider</button>
      <button class="btn-ikincil btn-kucuk" id="btn-transfer">⇄ Transfer</button>
    </div>` : ""}
    ${kasaVeresiye ? `
    <div class="kasa-islem-butonlar">
      <button class="btn-birincil btn-kucuk" id="btn-veresiye-giris">+ Veresiye Girişi</button>
      <button class="btn-ikincil btn-kucuk" id="btn-tahsilat">✓ Tahsilat Yap</button>
    </div>` : ""}
    <div class="gecmis-filtre-bant">
      <button class="gecmis-filtre-btn aktif" data-filtre="bugun">Bugün</button>
      <button class="gecmis-filtre-btn" data-filtre="son7">Son 7 Gün</button>
      <button class="gecmis-filtre-btn" data-filtre="son30">Son 30 Gün</button>
    </div>
    <div id="detay-icerik">Yükleniyor...</div>
  `;
  elem("btn-geri").addEventListener("click", () => kasalarSayfasi(kapsayici));

  const detayiYenile = async () => {
    const [kasaDocSnap, hareketSnap] = await Promise.all([
      getDoc(doc(db, "kasalar", kasa.id)),
      getDocs(query(collection(db, "kasaHareketleri"), where("kasaId", "==", kasa.id))),
    ]);
    const guncelBakiye = kasaDocSnap.data()?.bakiye ?? kasa.bakiye;

    let basTarihMs;
    if (filtre === "son7") {
      const d = new Date();
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      d.setDate(d.getDate() - 6); d.setHours(6, 0, 0, 0);
      basTarihMs = d.getTime();
    } else if (filtre === "son30") {
      const d = new Date();
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      d.setDate(d.getDate() - 29); d.setHours(6, 0, 0, 0);
      basTarihMs = d.getTime();
    } else {
      basTarihMs = bugunBaslangic().toMillis();
    }

    const hareketler = hareketSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(h => h.tarih && h.tarih.toMillis() >= basTarihMs)
      .sort((a, b) => b.tarih.toMillis() - a.tarih.toMillis());

    const gelir    = hareketler.filter(h => h.tur === "gelir").reduce((t, h) => t + h.tutar, 0);
    const gider    = hareketler.filter(h => h.tur === "gider").reduce((t, h) => t + h.tutar, 0);
    const tahsilat = hareketler.filter(h => h.tur === "tahsilat").reduce((t, h) => t + h.tutar, 0);

    const donemEtiketi = { bugun: "Bugün", son7: "Son 7 Gün", son30: "Son 30 Gün" }[filtre] || "Bugün";
    const ozetHtml = kasaVeresiye
      ? `<div>Bakiye: <strong>${paraBicimlendir(guncelBakiye)}</strong></div>
         <div>${donemEtiketi} Tahsilat: <strong class="pozitif">${paraBicimlendir(tahsilat)}</strong></div>
         <div>${donemEtiketi} Veresiye: <strong class="negatif">${paraBicimlendir(gelir)}</strong></div>`
      : `<div>Bakiye: <strong>${paraBicimlendir(guncelBakiye)}</strong></div>
         <div>${donemEtiketi} Gelir: <strong class="pozitif">${paraBicimlendir(gelir)}</strong></div>
         <div>${donemEtiketi} Tahsilat: <strong class="pozitif">${paraBicimlendir(tahsilat)}</strong></div>
         <div>${donemEtiketi} Gider: <strong class="negatif">${paraBicimlendir(gider)}</strong></div>`;

    const turEtiket = kasaVeresiye
      ? { gelir: "Veresiye", gider: "Gider", tahsilat: "Tahsilat", transfer_giris: "Transfer (+)", transfer_cikis: "Transfer (−)" }
      : { gelir: "Gelir",    gider: "Gider", tahsilat: "Tahsilat", transfer_giris: "Transfer (+)", transfer_cikis: "Transfer (−)" };

    const satirlar = hareketler.length === 0
      ? `<tr><td colspan="4" class="bos-hucre">İşlem bulunamadı</td></tr>`
      : hareketler.map(h => {
          const dt = h.tarih?.toDate();
          const tarihSaat = dt
            ? `${String(dt.getDate()).padStart(2,"0")}/${String(dt.getMonth()+1).padStart(2,"0")}/${String(dt.getFullYear()).slice(-2)} ${dt.toLocaleTimeString("tr-TR",{hour:"2-digit",minute:"2-digit"})}`
            : "—";
          const tur = turEtiket[h.tur] ?? h.tur;
          const turClass = kasaVeresiye
            ? (h.tur === "tahsilat" ? "tahsilat-renk" : h.tur === "gelir" ? "negatif" : "pozitif")
            : (h.tur === "tahsilat" ? "tahsilat-renk" : ["gelir", "transfer_giris"].includes(h.tur) ? "pozitif" : "negatif");
          const aciklama = [h.aciklama, h.oyuncuAd].filter(Boolean).join(" · ");
          const silinebilir = kasaVeresiye && ["manuel_veresiye", "tahsilat"].includes(h.kategori);
          const trClass = silinebilir ? "hareket-satir silinebilir-satir" : "hareket-satir";
          const trData  = silinebilir
            ? `data-id="${h.id}" data-kategori="${h.kategori}" data-tutar="${h.tutar}"
               data-oyuncu-id="${h.oyuncuId || ''}" data-hedef-kasa-id="${h.hedefKasaId || ''}"
               data-tahsilat-id="${h.tahsilatId || ''}"`
            : "";
          return `<tr class="${trClass}" ${trData}>
            <td class="tarih-saat-hucre">${tarihSaat}</td>
            <td class="${turClass}">${tur}</td>
            <td>${aciklama || "—"}</td>
            <td class="sayi ${turClass}">${paraBicimlendir(h.tutar)}</td>
          </tr>`;
        }).join("");

    elem("detay-icerik").innerHTML = `
      <div class="detay-ozet">${ozetHtml}</div>
      <table class="hareket-tablo">
        <thead><tr><th>Tarih</th><th>Tür</th><th>Açıklama</th><th>Tutar</th></tr></thead>
        <tbody>${satirlar}</tbody>
      </table>
    `;

    if (kasaVeresiye) {
      elem("detay-icerik").querySelectorAll(".silinebilir-satir").forEach(satir => {
        satir.addEventListener("click", () => {
          // Zaten açık aksiyon satırı varsa kapat
          const mevcutAksiyon = satir.nextElementSibling;
          if (mevcutAksiyon?.classList.contains("aksiyon-satir")) {
            mevcutAksiyon.remove();
            satir.classList.remove("secili-satir");
            return;
          }
          // Diğer açık aksiyon satırlarını kapat
          elem("detay-icerik").querySelectorAll(".aksiyon-satir").forEach(r => r.remove());
          elem("detay-icerik").querySelectorAll(".secili-satir").forEach(r => r.classList.remove("secili-satir"));

          satir.classList.add("secili-satir");
          const aksiyonSatir = document.createElement("tr");
          aksiyonSatir.className = "aksiyon-satir";
          aksiyonSatir.innerHTML = `
            <td colspan="4" class="aksiyon-hucre">
              <span>Bu kaydı silmek istiyor musunuz?</span>
              <button class="btn-aksiyon-sil">Evet, Sil</button>
              <button class="btn-aksiyon-iptal">İptal</button>
            </td>`;
          satir.after(aksiyonSatir);

          aksiyonSatir.querySelector(".btn-aksiyon-iptal").addEventListener("click", () => {
            aksiyonSatir.remove();
            satir.classList.remove("secili-satir");
          });

          aksiyonSatir.querySelector(".btn-aksiyon-sil").addEventListener("click", async () => {
            const tutar       = parseFloat(satir.dataset.tutar);
            const kategori    = satir.dataset.kategori;
            const oyuncuId    = satir.dataset.oyuncuId;
            const hedefKasaId = satir.dataset.hedefKasaId;
            const tahsilatId  = satir.dataset.tahsilatId;
            aksiyonSatir.querySelector(".btn-aksiyon-sil").disabled = true;
            try {
              if (kategori === "manuel_veresiye") {
                await Promise.all([
                  deleteDoc(doc(db, "kasaHareketleri", satir.dataset.id)),
                  updateDoc(doc(db, "kasalar", kasa.id), { bakiye: increment(-tutar) }),
                  ...(oyuncuId ? [updateDoc(doc(db, "kullanicilar", oyuncuId), { veresiye: increment(-tutar) })] : []),
                ]);
              } else if (kategori === "tahsilat") {
                const ops = [
                  deleteDoc(doc(db, "kasaHareketleri", satir.dataset.id)),
                  updateDoc(doc(db, "kasalar", kasa.id), { bakiye: increment(tutar) }),
                  ...(oyuncuId ? [updateDoc(doc(db, "kullanicilar", oyuncuId), { veresiye: increment(tutar) })] : []),
                ];
                if (hedefKasaId && tahsilatId) {
                  const karsinSnap = await getDocs(query(
                    collection(db, "kasaHareketleri"),
                    where("tahsilatId", "==", tahsilatId),
                    where("kasaId", "==", hedefKasaId)
                  ));
                  karsinSnap.docs.forEach(d => ops.push(deleteDoc(doc(db, "kasaHareketleri", d.id))));
                  ops.push(updateDoc(doc(db, "kasalar", hedefKasaId), { bakiye: increment(-tutar) }));
                }
                await Promise.all(ops);
              }
              await detayiYenile();
            } catch (err) {
              alert("Silme hatası: " + err.message);
              aksiyonSatir.querySelector(".btn-aksiyon-sil").disabled = false;
            }
          });
        });
      });
    }
  };

  kapsayici.querySelectorAll(".gecmis-filtre-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      filtre = btn.dataset.filtre;
      kapsayici.querySelectorAll(".gecmis-filtre-btn").forEach(b => b.classList.toggle("aktif", b === btn));
      detayiYenile();
    });
  });

  if (kasaIslemleri) {
    elem("btn-gelir-ekle").addEventListener("click", () => gelirGiderModalAc(kasa, "gelir", detayiYenile));
    elem("btn-gider-ekle").addEventListener("click", () => gelirGiderModalAc(kasa, "gider", detayiYenile));
    elem("btn-transfer").addEventListener("click", () => transferModalAc(kasa, detayiYenile));
  }
  if (kasaVeresiye) {
    elem("btn-veresiye-giris").addEventListener("click", () => veresiyeGirisModalAc(kasa, detayiYenile));
    elem("btn-tahsilat").addEventListener("click", () => tahsilatYapModalAc(kasa, detayiYenile));
  }

  await detayiYenile();
}

async function veresiyeGirisModalAc(kasa, onSuccess) {
  const oyuncuSnap = await getDocs(collection(db, "kullanicilar"));
  const oyuncular = oyuncuSnap.docs
    .filter(d => d.data().rol === "oyuncu")
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.adSoyad || "").localeCompare(b.adSoyad || "", "tr"));

  const modal = document.createElement("div");
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>Manuel Veresiye Girişi</h3>
      <form id="vg-form">
        <label>Oyuncu</label>
        <input type="text" id="vg-ara" placeholder="İsim ile ara…" autocomplete="off" />
        <div class="oyuncu-secim-liste" id="vg-liste"></div>
        <label>Tutar (TL)</label>
        <input type="number" id="vg-tutar" min="0.01" step="0.01" required />
        <label>Açıklama</label>
        <input type="text" id="vg-aciklama" placeholder="İsteğe bağlı" />
        <p id="vg-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Kaydet</button>
          <button type="button" id="btn-vg-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-vg-iptal").addEventListener("click", () => modal.remove());

  let seciliOyuncu = null;
  function vgListeRender(filtre) {
    const liste = elem("vg-liste");
    const k = (filtre || "").toLowerCase();
    const gorunenler = oyuncular.filter(o => !k || (o.adSoyad || "").toLowerCase().includes(k));
    liste.innerHTML = gorunenler.length
      ? gorunenler.map(o => `
          <div class="oyuncu-secim-satir${seciliOyuncu?.id === o.id ? " secili" : ""}" data-id="${o.id}">
            <span class="oyss-ad">${o.adSoyad || o.kullaniciAdi}</span>
            <span class="oyss-bakiye${(o.veresiye || 0) > 0 ? " negatif" : ""}">${paraBicimlendir(o.veresiye || 0)}</span>
          </div>`).join("")
      : `<p class="bos-mesaj">Oyuncu bulunamadı.</p>`;
    liste.querySelectorAll(".oyuncu-secim-satir").forEach(s => {
      s.addEventListener("click", () => { seciliOyuncu = oyuncular.find(o => o.id === s.dataset.id) || null; vgListeRender(elem("vg-ara").value); });
    });
  }
  elem("vg-ara").addEventListener("input", () => vgListeRender(elem("vg-ara").value));
  vgListeRender("");

  elem("vg-form").addEventListener("submit", async e => {
    e.preventDefault();
    const hataEl = elem("vg-hata");
    if (!seciliOyuncu) { hataEl.textContent = "Lütfen bir oyuncu seçin."; hataEl.classList.remove("gizli"); return; }
    const tutar = parseFloat(elem("vg-tutar").value);
    if (!tutar || tutar <= 0) return;
    const aciklama = elem("vg-aciklama").value.trim() || "Manuel veresiye";
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await Promise.all([
        addDoc(collection(db, "kasaHareketleri"), {
          kasaId: kasa.id, tutar, tur: "gelir", aciklama,
          kategori: "manuel_veresiye",
          oyuncuId: seciliOyuncu.id,
          oyuncuAd: seciliOyuncu.adSoyad || seciliOyuncu.kullaniciAdi,
          tarih: serverTimestamp(),
        }),
        updateDoc(doc(db, "kasalar", kasa.id), { bakiye: increment(tutar) }),
        updateDoc(doc(db, "kullanicilar", seciliOyuncu.id), { veresiye: increment(tutar) }),
      ]);
      modal.remove();
      await onSuccess();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

async function tahsilatYapModalAc(veresiyeKasa, onSuccess) {
  const [oyuncuSnap, kasaSnap] = await Promise.all([
    getDocs(collection(db, "kullanicilar")),
    getDocs(query(collection(db, "kasalar"), orderBy("sira"))),
  ]);
  const oyuncular = oyuncuSnap.docs
    .filter(d => d.data().rol === "oyuncu")
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.adSoyad || "").localeCompare(b.adSoyad || "", "tr"));
  const kasalar = kasaSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(k => k.tip !== "veresiye");

  const modal = document.createElement("div");
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>Tahsilat Yap</h3>
      <form id="tah-form">
        <label>Oyuncu</label>
        <input type="text" id="tah-ara" placeholder="İsim ile ara…" autocomplete="off" />
        <div class="oyuncu-secim-liste" id="tah-liste"></div>
        <div id="tah-ozet" class="veresiye-ozet gizli"></div>
        <div class="tum-bakiye-satir">
          <label>Tahsilat Tutarı (TL)</label>
          <button type="button" id="btn-tum-bakiye" class="btn-tum-bakiye gizli">Tüm Bakiye</button>
        </div>
        <input type="number" id="tah-tutar" min="0.01" step="0.01" required />
        <label>Tahsilat Kasası</label>
        <select id="tah-kasa">${kasalar.map(k => `<option value="${k.id}">${k.ad}</option>`).join("")}</select>
        <label>Açıklama</label>
        <input type="text" id="tah-aciklama" placeholder="İsteğe bağlı" />
        <p id="tah-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Tahsilat Yap</button>
          <button type="button" id="btn-tah-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-tah-iptal").addEventListener("click", () => modal.remove());

  let seciliOyuncu = null;
  function tahOzetGuncelle() {
    const ozetEl = elem("tah-ozet");
    const tumBtn = elem("btn-tum-bakiye");
    if (!seciliOyuncu) {
      ozetEl.classList.add("gizli");
      tumBtn.classList.add("gizli");
      return;
    }
    const mevcut = seciliOyuncu.veresiye || 0;
    ozetEl.classList.remove("gizli");
    ozetEl.innerHTML = `<div class="veresiye-ozet-satir"><span>Mevcut Bakiye</span>
      <span class="${mevcut > 0 ? "negatif" : ""}">${paraBicimlendir(mevcut)}</span></div>`;
    if (mevcut > 0) {
      tumBtn.classList.remove("gizli");
      tumBtn.onclick = () => { elem("tah-tutar").value = mevcut.toFixed(2); };
    } else {
      tumBtn.classList.add("gizli");
    }
  }
  function tahListeRender(filtre) {
    const liste = elem("tah-liste");
    const k = (filtre || "").toLowerCase();
    const gorunenler = oyuncular.filter(o => !k || (o.adSoyad || "").toLowerCase().includes(k));
    liste.innerHTML = gorunenler.length
      ? gorunenler.map(o => `
          <div class="oyuncu-secim-satir${seciliOyuncu?.id === o.id ? " secili" : ""}" data-id="${o.id}">
            <span class="oyss-ad">${o.adSoyad || o.kullaniciAdi}</span>
            <span class="oyss-bakiye${(o.veresiye || 0) > 0 ? " negatif" : ""}">${paraBicimlendir(o.veresiye || 0)}</span>
          </div>`).join("")
      : `<p class="bos-mesaj">Oyuncu bulunamadı.</p>`;
    liste.querySelectorAll(".oyuncu-secim-satir").forEach(s => {
      s.addEventListener("click", () => {
        seciliOyuncu = oyuncular.find(o => o.id === s.dataset.id) || null;
        tahListeRender(elem("tah-ara").value);
        tahOzetGuncelle();
      });
    });
  }
  elem("tah-ara").addEventListener("input", () => tahListeRender(elem("tah-ara").value));
  tahListeRender("");

  elem("tah-form").addEventListener("submit", async e => {
    e.preventDefault();
    const hataEl = elem("tah-hata");
    if (!seciliOyuncu) { hataEl.textContent = "Lütfen bir oyuncu seçin."; hataEl.classList.remove("gizli"); return; }
    const tutar = parseFloat(elem("tah-tutar").value);
    if (!tutar || tutar <= 0) return;
    const hedefKasaId = elem("tah-kasa").value;
    const hedefKasaAd = kasalar.find(k => k.id === hedefKasaId)?.ad || "";
    const aciklama    = elem("tah-aciklama").value.trim();
    const oyuncuAd    = seciliOyuncu.adSoyad || seciliOyuncu.kullaniciAdi;
    const tahsilatId  = `tah_${Date.now()}`;
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await Promise.all([
        addDoc(collection(db, "kasaHareketleri"), {
          kasaId: veresiyeKasa.id, tutar, tur: "tahsilat",
          aciklama: aciklama || `Tahsilat → ${hedefKasaAd}`,
          kategori: "tahsilat", oyuncuId: seciliOyuncu.id, oyuncuAd,
          hedefKasaId, tahsilatId, tarih: serverTimestamp(),
        }),
        addDoc(collection(db, "kasaHareketleri"), {
          kasaId: hedefKasaId, tutar, tur: "tahsilat",
          aciklama: aciklama || `Veresiye Tahsilat - ${oyuncuAd}`,
          kategori: "tahsilat_giris", oyuncuId: seciliOyuncu.id, oyuncuAd,
          kaynakKasaId: veresiyeKasa.id, tahsilatId, tarih: serverTimestamp(),
        }),
        updateDoc(doc(db, "kasalar", veresiyeKasa.id), { bakiye: increment(-tutar) }),
        updateDoc(doc(db, "kasalar", hedefKasaId),     { bakiye: increment(tutar) }),
        updateDoc(doc(db, "kullanicilar", seciliOyuncu.id), { veresiye: increment(-tutar) }),
      ]);
      modal.remove();
      await onSuccess();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

function gelirGiderModalAc(kasa, tur, onSuccess) {
  const baslik = tur === "gelir" ? "Gelir Ekle" : "Gider Ekle";
  const modal = document.createElement("div");
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${kasa.ad} — ${baslik}</h3>
      <form id="gg-form">
        <label>Tutar (TL)</label>
        <input type="number" id="gg-tutar" min="0.01" step="0.01" required autofocus />
        <label>Açıklama</label>
        <input type="text" id="gg-aciklama" />
        <p id="gg-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">${baslik}</button>
          <button type="button" id="btn-gg-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-gg-iptal").addEventListener("click", () => modal.remove());

  elem("gg-form").addEventListener("submit", async e => {
    e.preventDefault();
    const tutar = parseFloat(elem("gg-tutar").value);
    if (!tutar || tutar <= 0) return;
    const aciklama = elem("gg-aciklama").value.trim() || (tur === "gelir" ? "Manuel gelir" : "Manuel gider");
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await addDoc(collection(db, "kasaHareketleri"), {
        kasaId: kasa.id, tutar, tur, aciklama,
        tarih: serverTimestamp(), kategori: "manuel",
      });
      await updateDoc(doc(db, "kasalar", kasa.id), {
        bakiye: increment(tur === "gelir" ? tutar : -tutar),
      });
      modal.remove();
      await onSuccess();
    } catch (err) {
      elem("gg-hata").textContent = "Hata: " + err.message;
      elem("gg-hata").classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

async function transferModalAc(kaynakKasa, onSuccess) {
  const kasaSnap = await getDocs(query(collection(db, "kasalar"), orderBy("sira")));
  const hedefler = kasaSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(k => k.id !== kaynakKasa.id && k.tip !== "veresiye");

  if (hedefler.length === 0) {
    alert("Transfer yapılacak başka kasa bulunamadı.");
    return;
  }

  const secenekler = hedefler.map(k => `<option value="${k.id}">${k.ad}</option>`).join("");
  const modal = document.createElement("div");
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${kaynakKasa.ad} — Transfer Gönder</h3>
      <form id="transfer-form">
        <label>Alıcı Kasa</label>
        <select id="transfer-hedef">${secenekler}</select>
        <label>Tutar (TL)</label>
        <input type="number" id="transfer-tutar" min="0.01" step="0.01" required />
        <label>Açıklama</label>
        <input type="text" id="transfer-aciklama" />
        <p id="transfer-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Gönder</button>
          <button type="button" id="btn-transfer-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-transfer-iptal").addEventListener("click", () => modal.remove());

  elem("transfer-form").addEventListener("submit", async e => {
    e.preventDefault();
    const tutar = parseFloat(elem("transfer-tutar").value);
    if (!tutar || tutar <= 0) return;
    const hedefId = elem("transfer-hedef").value;
    const hedefAd = hedefler.find(k => k.id === hedefId)?.ad || "";
    const aciklama = elem("transfer-aciklama").value.trim();
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await Promise.all([
        addDoc(collection(db, "kasaHareketleri"), {
          kasaId: kaynakKasa.id, tutar, tur: "transfer_cikis",
          aciklama: aciklama || `Transfer → ${hedefAd}`,
          tarih: serverTimestamp(), kategori: "transfer", hedefKasaId: hedefId,
        }),
        addDoc(collection(db, "kasaHareketleri"), {
          kasaId: hedefId, tutar, tur: "transfer_giris",
          aciklama: aciklama || `Transfer ← ${kaynakKasa.ad}`,
          tarih: serverTimestamp(), kategori: "transfer", kaynakKasaId: kaynakKasa.id,
        }),
        updateDoc(doc(db, "kasalar", kaynakKasa.id), { bakiye: increment(-tutar) }),
        updateDoc(doc(db, "kasalar", hedefId),       { bakiye: increment(tutar) }),
      ]);
      modal.remove();
      await onSuccess();
    } catch (err) {
      elem("transfer-hata").textContent = "Hata: " + err.message;
      elem("transfer-hata").classList.remove("gizli");
      btn.disabled = false;
    }
  });
}


// ============================================================
// 13. VERESİYE İŞLEMLERİ
// Oyuncuya borç bağlama ve tahsilat.
// Oyuncular modülü tamamlanınca bu bölüm aktif edilecek.
// ============================================================



// ============================================================
// 15. RAPOR MODÜLÜ
// Tarih aralığı + kasa + kategori filtreli raporlama.
// Toplam tutarlar tablo üstünde, detay listesi altında.
// Excel (.xlsx) export desteği eklenecek.
// ============================================================

// TODO: raporSayfasi()


// ============================================================
// 16. OYUNCULAR SAYFASI
// Kayıtlı oyuncu listesi, veresiye bakiyesi ve geçmiş.
// Yapım aşamasında.
// ============================================================

async function oyuncularSayfasi(kapsayici) {
  const isAdmin = durum.kullanici?.rol === "admin";

  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <h2>Oyuncular</h2>
      ${isAdmin ? `<button id="btn-oyuncu-ekle-ac" class="btn-birincil btn-kucuk">+ Oyuncu Ekle</button>` : ""}
    </div>
    <div id="oyuncu-listesi">Yükleniyor...</div>
  `;

  oyuncuListesiYukle();

  if (isAdmin) {
    elem("btn-oyuncu-ekle-ac").addEventListener("click", oyuncuEkleModalAc);
  }
}

function oyuncuEkleModalAc() {
  elem("oyuncu-ekle-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "oyuncu-ekle-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>Yeni Oyuncu Ekle</h3>
      <input type="text" id="oyuncu-ad" placeholder="İSİM SOYİSİM" style="text-transform:uppercase" />
      <input type="text" id="oyuncu-kullanici" placeholder="Kullanıcı Adı" autocomplete="off" />
      <select id="oyuncu-tip">
        <option value="bilardo">Bilardo</option>
        <option value="genel">Genel</option>
      </select>
      <p class="profil-aciklama">Varsayılan şifre: <strong>123456</strong> — Oyuncu ilk girişte değiştirir.</p>
      <p id="oyuncu-hata" class="hata gizli"></p>
      <div class="modal-butonlar">
        <button id="btn-oyuncu-ekle" class="btn-birincil">Ekle</button>
        <button id="btn-oyuncu-ekle-iptal" class="btn-iptal">İptal</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-oyuncu-ekle-iptal").addEventListener("click", () => modal.remove());

  elem("oyuncu-ad").addEventListener("input", function() {
    const s = this.selectionStart, e = this.selectionEnd;
    this.value = this.value.toUpperCase();
    this.setSelectionRange(s, e);
  });

  let kullaniciManuel = false;
  elem("oyuncu-kullanici").addEventListener("input", () => { kullaniciManuel = true; });
  elem("oyuncu-ad").addEventListener("input", () => {
    if (kullaniciManuel) return;
    const deger = elem("oyuncu-ad").value;
    if (!deger.includes(" ")) return;
    const parcalar = deger.split(/\s+/).filter(p => p);
    if (!parcalar[0]) return;
    const oneri = turkceTemizle(parcalar[0][0] + parcalar.slice(1).join(""))
      .toLowerCase().replace(/[^a-z0-9]/g, "");
    elem("oyuncu-kullanici").value = oneri;
  });

  elem("btn-oyuncu-ekle").addEventListener("click", async () => {
    const hataEl = elem("oyuncu-hata");
    hataEl.classList.add("gizli");
    const adSoyad = elem("oyuncu-ad").value.trim();
    const kullaniciAdi = elem("oyuncu-kullanici").value.trim().toLowerCase();

    if (!adSoyad || !kullaniciAdi) {
      hataEl.textContent = "İsim soyisim ve kullanıcı adı gerekli.";
      hataEl.classList.remove("gizli");
      return;
    }

    const btn = elem("btn-oyuncu-ekle");
    btn.disabled = true;
    const kaydet = async () => {
      const ikincilApp = initializeApp(FIREBASE_CONFIG, `ikincil_${Date.now()}`);
      const ikincilAuth = getAuth(ikincilApp);
      let uid;
      try {
        const kred = await createUserWithEmailAndPassword(ikincilAuth, kuadEmaile(kullaniciAdi), "123456");
        uid = kred.user.uid;
      } finally {
        await deleteApp(ikincilApp).catch(() => {});
      }
      await setDoc(doc(db, "kullanicilar", uid), {
        kullaniciAdi, adSoyad,
        tip: elem("oyuncu-tip").value,
        rol: "oyuncu",
        tel: "", email: "",
        genelAvg: 0, enYuksekAvg: 0,
        eys1: 0, eys2: 0, toplamPuan: 0,
        veresiye: 0, ilkGiris: true, sifre: "123456",
      });
    };

    try {
      await kaydet();
      modal.remove();
      oyuncuListesiYukle();
    } catch (err) {
      if (err.code === "auth/email-already-in-use") {
        await authHesabiniSil(kullaniciAdi, "123456");
        try {
          await kaydet();
          modal.remove();
          oyuncuListesiYukle();
          return;
        } catch (err2) {
          hataEl.textContent = err2.code === "auth/email-already-in-use"
            ? "Bu kullanıcı adı Firebase'de kayıtlı. Console'dan silin."
            : "Hata: " + err2.message;
        }
      } else {
        hataEl.textContent = "Hata: " + err.message;
      }
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}

async function oyuncuListesiYukle() {
  const el = elem("oyuncu-listesi");
  if (!el) return;
  const isAdmin = durum.kullanici?.rol === "admin";

  const snap = await getDocs(query(collection(db, "kullanicilar"), where("rol", "==", "oyuncu")));
  const oyuncular = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.adSoyad || "").localeCompare(b.adSoyad || "", "tr"));

  if (oyuncular.length === 0) {
    el.innerHTML = `<p class="bos-mesaj">Henüz oyuncu eklenmedi.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="oyuncu-tablo-kapsayici">
      <table class="oyuncu-tablo">
        <thead>
          <tr>
            <th>İsim Soyisim</th>
            <th>Kullanıcı</th>
            <th>Tip</th>
            <th>Tel</th>
            <th>E-posta</th>
            <th>G.Avg</th>
            <th>E.Y.Avg</th>
            <th>EYS1</th>
            <th>EYS2</th>
            <th>Puan</th>
            <th>Bakiye</th>
            ${isAdmin ? `<th>İşlem</th>` : ""}
          </tr>
        </thead>
        <tbody>
          ${oyuncular.map(o => `
            <tr>
              <td>${o.adSoyad || "—"}</td>
              <td>@${o.kullaniciAdi || "—"}</td>
              <td>${o.tip === "bilardo" ? "Bilardo" : "Genel"}</td>
              <td>${o.tel || "—"}</td>
              <td>${o.email || "—"}</td>
              <td>${(o.genelAvg || 0).toFixed(3)}</td>
              <td>${(o.enYuksekAvg || 0).toFixed(3)}</td>
              <td>${o.eys1 || 0}</td>
              <td>${o.eys2 || 0}</td>
              <td>${o.toplamPuan || 0}</td>
              <td class="${(o.veresiye || 0) > 0 ? "negatif" : ""}">${paraBicimlendir(o.veresiye || 0)}</td>
              ${isAdmin ? `<td class="oyuncu-islem-hucre">
                <button class="btn-ikincil btn-kucuk btn-oyuncu-duzenle" data-id="${o.id}">Düzenle</button>
                <button class="btn-sil btn-oyuncu-sil" data-id="${o.id}">Sil</button>
              </td>` : ""}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  if (!isAdmin) return;

  el.querySelectorAll(".btn-oyuncu-duzenle").forEach(btn => {
    btn.addEventListener("click", () => {
      const o = oyuncular.find(x => x.id === btn.dataset.id);
      if (o) oyuncuDuzenleModalAc(o);
    });
  });

  el.querySelectorAll(".btn-oyuncu-sil").forEach(btn => {
    btn.addEventListener("click", async () => {
      const oyuncu = oyuncular.find(x => x.id === btn.dataset.id);
      if (!oyuncu) return;
      if (!confirm("Bu oyuncuyu silmek istediğinize emin misiniz?")) return;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, "kullanicilar", btn.dataset.id));
        authHesabiniSil(oyuncu.kullaniciAdi, oyuncu.sifre); // fire-and-forget
        oyuncuListesiYukle();
      } catch (err) {
        alert("Hata: " + err.message);
        btn.disabled = false;
      }
    });
  });
}

function oyuncuDuzenleModalAc(oyuncu) {
  elem("oyuncu-duzenle-modal")?.remove();
  const modal = document.createElement("div");
  modal.id = "oyuncu-duzenle-modal";
  modal.className = "modal-arka-plan";
  modal.innerHTML = `
    <div class="modal-kutu">
      <h3>${oyuncu.adSoyad} — Düzenle</h3>
      <form id="oyuncu-duzenle-form">
        <input type="text" id="od-adsoyad" placeholder="İsim Soyisim" value="${oyuncu.adSoyad || ""}" style="text-transform:uppercase" required />
        <input type="text" value="@${oyuncu.kullaniciAdi || ""}" disabled class="input-readonly" title="Kullanıcı adı değiştirilemez" />
        <select id="od-tip">
          <option value="bilardo" ${oyuncu.tip === "bilardo" ? "selected" : ""}>Bilardo</option>
          <option value="genel" ${oyuncu.tip === "genel" ? "selected" : ""}>Genel</option>
        </select>
        <input type="tel" id="od-tel" placeholder="Telefon" value="${oyuncu.tel || ""}" />
        <input type="email" id="od-email" placeholder="E-posta (isteğe bağlı)" value="${oyuncu.email || ""}" />
        <div class="sifre-goster-satir">
          <input type="password" id="od-sifre" value="${oyuncu.sifre || "—"}" readonly class="input-readonly" />
          <button type="button" id="btn-od-sifre-goster" class="btn-ikincil btn-kucuk">Göster</button>
        </div>
        <p id="od-hata" class="hata gizli"></p>
        <div class="modal-butonlar">
          <button type="submit" class="btn-birincil">Kaydet</button>
          <button type="button" id="btn-od-iptal" class="btn-iptal">İptal</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) modal.remove(); });
  elem("btn-od-iptal").addEventListener("click", () => modal.remove());
  elem("btn-od-sifre-goster").addEventListener("click", () => {
    const inp = elem("od-sifre");
    const gizli = inp.type === "password";
    inp.type = gizli ? "text" : "password";
    elem("btn-od-sifre-goster").textContent = gizli ? "Gizle" : "Göster";
  });

  elem("oyuncu-duzenle-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("[type='submit']");
    btn.disabled = true;
    try {
      await updateDoc(doc(db, "kullanicilar", oyuncu.id), {
        adSoyad: elem("od-adsoyad").value.trim().toUpperCase(),
        tip:     elem("od-tip").value,
        tel:     elem("od-tel").value.trim(),
        email:   elem("od-email").value.trim(),
      });
      modal.remove();
      oyuncuListesiYukle();
    } catch (err) {
      elem("od-hata").textContent = "Hata: " + err.message;
      elem("od-hata").classList.remove("gizli");
      btn.disabled = false;
    }
  });
}


// ============================================================
// 17. YÖNETİM PANELİ
// Masalar ve kasalar sekmeli olarak yönetilir.
// Admin masa ekleyip silebilir, kasa ekleyip silebilir.
// Nakit, Banka, Veresiye sistem kasaları silinemez.
// ============================================================

const YONETIM_MENUSU = [
  { id: "masalar", etiket: "Masalar",        aciklama: "Masa ekle, sil, ücret güncelle" },
  { id: "kasalar", etiket: "Kasalar",        aciklama: "Kasa ekle, sil" },
  { id: "urunler", etiket: "Ürünler",        aciklama: "Ürün ve fiyat tanımla" },
  { id: "firma",   etiket: "Firma Bilgileri", aciklama: "Firma adı ve genel ayarlar" },
];

function yonetimSayfasi(kapsayici) {
  kapsayici.innerHTML = `
    <div class="sayfa-baslik"><h2>Yönetim Paneli</h2></div>
    <div class="yonetim-menu">
      ${YONETIM_MENUSU.map(m => `
        <button class="yonetim-menu-satir" data-menu="${m.id}">
          <div>
            <div class="yonetim-menu-etiket">${m.etiket}</div>
            <div class="yonetim-menu-aciklama">${m.aciklama}</div>
          </div>
          <span class="yonetim-menu-ok">›</span>
        </button>
      `).join("")}
    </div>
  `;

  kapsayici.querySelectorAll(".yonetim-menu-satir").forEach(btn => {
    btn.addEventListener("click", () => {
      const menu = btn.dataset.menu;
      if (menu === "masalar") masaYonetimi(kapsayici);
      else if (menu === "kasalar") kasaYonetimi(kapsayici);
      else if (menu === "urunler") urunYonetimi(kapsayici);
      else if (menu === "firma")   firmaYonetimi(kapsayici);
    });
  });
}

async function masaYonetimi(kapsayici) {
  const katSnap = await getDocs(query(collection(db, "masaKategorileri"), orderBy("sira")));
  const kategoriler = katSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const katSecenekleri = kategoriler.map(k => `<option value="${k.id}">${k.ad}</option>`).join("");

  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <button class="btn-geri" id="btn-yonetim-geri">← Yönetim</button>
      <h2>Masalar</h2>
    </div>
    <div class="yonetim-form-kart">
      <h3>Yeni Masa Ekle</h3>
      <input type="text" id="masa-ad" placeholder="Masa Adı" />
      <select id="masa-kategori">${katSecenekleri}</select>
      <label class="checkbox-label">
        <input type="checkbox" id="masa-sureli" />
        Süreli masa (süre bazlı ücret)
      </label>
      <div id="saatlik-ucret-alan" class="gizli">
        <input type="number" id="masa-saatlik-ucret" placeholder="Saatlik Ücret (₺)" min="0" step="0.01" />
      </div>
      <p id="masa-hata" class="hata gizli"></p>
      <button id="btn-masa-ekle" class="btn-birincil">Ekle</button>
    </div>
    <div id="masa-listesi">Yükleniyor...</div>
  `;

  elem("btn-yonetim-geri").addEventListener("click", () => yonetimSayfasi(kapsayici));
  elem("masa-sureli").addEventListener("change", e => {
    elem("saatlik-ucret-alan").classList.toggle("gizli", !e.target.checked);
  });

  masaListesiYukle();

  elem("btn-masa-ekle").addEventListener("click", async () => {
    const hataEl = elem("masa-hata");
    hataEl.classList.add("gizli");
    const ad = elem("masa-ad").value.trim();
    if (!ad) {
      hataEl.textContent = "Masa adı gerekli.";
      hataEl.classList.remove("gizli");
      return;
    }
    const btn = elem("btn-masa-ekle");
    btn.disabled = true;
    const kategoriId = elem("masa-kategori").value;
    const sureli = elem("masa-sureli").checked;
    const saatlikUcret = sureli ? parseFloat(elem("masa-saatlik-ucret").value || 0) : 0;

    const masaSnap = await getDocs(collection(db, "masalar"));
    const maxSira = masaSnap.docs.reduce((max, d) => Math.max(max, d.data().sira ?? 0), -1);

    try {
      await addDoc(collection(db, "masalar"), {
        ad, kategoriId, sureli, saatlikUcret,
        sira: maxSira + 1,
        aktif: false, acilisSaati: null, toplamTutar: 0,
      });
      elem("masa-ad").value = "";
      elem("masa-saatlik-ucret").value = "";
      elem("masa-sureli").checked = false;
      elem("saatlik-ucret-alan").classList.add("gizli");
      masaListesiYukle();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
    }
    btn.disabled = false;
  });
}

async function masaListesiYukle() {
  const el = elem("masa-listesi");
  if (!el) return;

  const [masaSnap, katSnap] = await Promise.all([
    getDocs(query(collection(db, "masalar"), orderBy("sira"))),
    getDocs(collection(db, "masaKategorileri")),
  ]);
  const katAdlari = Object.fromEntries(katSnap.docs.map(d => [d.id, d.data().ad]));
  const masalar = masaSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (masalar.length === 0) {
    el.innerHTML = `<p class="bos-mesaj">Henüz masa eklenmedi.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="yonetim-liste">
      ${masalar.map(m => `
        <div class="yonetim-liste-satir" data-id="${m.id}">
          <div style="flex:1">
            <div class="yonetim-liste-ad">${m.ad}</div>
            <div class="yonetim-liste-detay">${katAdlari[m.kategoriId] || "—"} · ${m.sureli ? `Süreli · ${paraBicimlendir(m.saatlikUcret || 0)}/saat` : "Süresiz"}</div>
            ${m.sureli ? `<div class="ucret-duzenle-alan gizli" id="ucret-alan-${m.id}">
              <div class="ucret-duzenle-satir">
                <input type="number" class="ucret-input" id="ucret-${m.id}" value="${m.saatlikUcret || 0}" min="0" step="0.01" placeholder="₺/saat" />
                <button class="btn-kaydet" data-id="${m.id}">Kaydet</button>
                <button class="btn-iptal-ucret" data-id="${m.id}">İptal</button>
              </div>
            </div>` : ""}
          </div>
          <div class="yonetim-satir-butonlar">
            ${m.sureli ? `<button class="btn-ikincil btn-duzenle" data-id="${m.id}">Ücret</button>` : ""}
            ${m.aktif ? `<span class="aktif-etiket">Aktif</span>` : `<button class="btn-sil" data-id="${m.id}">Sil</button>`}
          </div>
        </div>
      `).join("")}
    </div>
  `;

  // Sil
  el.querySelectorAll(".btn-sil").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Bu masayı silmek istediğinize emin misiniz?")) return;
      await deleteDoc(doc(db, "masalar", btn.dataset.id));
      masaListesiYukle();
    });
  });

  // Ücret düzenle aç/kapat
  el.querySelectorAll(".btn-duzenle").forEach(btn => {
    btn.addEventListener("click", () => {
      const alan = elem(`ucret-alan-${btn.dataset.id}`);
      alan.classList.toggle("gizli");
    });
  });

  // İptal
  el.querySelectorAll(".btn-iptal-ucret").forEach(btn => {
    btn.addEventListener("click", () => {
      elem(`ucret-alan-${btn.dataset.id}`).classList.add("gizli");
    });
  });

  // Kaydet
  el.querySelectorAll(".btn-kaydet").forEach(btn => {
    btn.addEventListener("click", async () => {
      const yeniUcret = parseFloat(elem(`ucret-${btn.dataset.id}`).value);
      if (isNaN(yeniUcret) || yeniUcret < 0) return;
      btn.disabled = true;
      await updateDoc(doc(db, "masalar", btn.dataset.id), { saatlikUcret: yeniUcret });
      masaListesiYukle();
    });
  });
}

async function kasaYonetimi(kapsayici) {
  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <button class="btn-geri" id="btn-yonetim-geri-kasa">← Yönetim</button>
      <h2>Kasalar</h2>
    </div>
    <div class="yonetim-form-kart">
      <h3>Yeni Kasa Ekle</h3>
      <input type="text" id="kasa-ad" placeholder="Kasa Adı" />
      <p id="kasa-hata" class="hata gizli"></p>
      <button id="btn-kasa-ekle" class="btn-birincil">Ekle</button>
    </div>
    <div id="kasa-listesi">Yükleniyor...</div>
  `;

  elem("btn-yonetim-geri-kasa").addEventListener("click", () => yonetimSayfasi(kapsayici));
  kasaListesiYukle();

  elem("btn-kasa-ekle").addEventListener("click", async () => {
    const hataEl = elem("kasa-hata");
    hataEl.classList.add("gizli");
    const ad = elem("kasa-ad").value.trim();
    if (!ad) {
      hataEl.textContent = "Kasa adı gerekli.";
      hataEl.classList.remove("gizli");
      return;
    }
    const btn = elem("btn-kasa-ekle");
    btn.disabled = true;

    const kasaSnap = await getDocs(collection(db, "kasalar"));
    const maxSira = kasaSnap.docs.reduce((max, d) => Math.max(max, d.data().sira ?? 0), -1);

    try {
      await addDoc(collection(db, "kasalar"), {
        ad, tip: "normal", silinebilir: true,
        sira: maxSira + 1, bakiye: 0,
      });
      elem("kasa-ad").value = "";
      kasaListesiYukle();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
    }
    btn.disabled = false;
  });
}

async function kasaListesiYukle() {
  const el = elem("kasa-listesi");
  if (!el) return;

  const snap = await getDocs(query(collection(db, "kasalar"), orderBy("sira")));
  const kasalar = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  el.innerHTML = `
    <div class="yonetim-liste">
      ${kasalar.map(k => `
        <div class="yonetim-liste-satir">
          <div>
            <div class="yonetim-liste-ad">${k.ad}</div>
            ${!k.silinebilir ? `<div class="yonetim-liste-detay">Sistem kasası</div>` : ""}
          </div>
          ${k.silinebilir ? `<button class="btn-sil" data-id="${k.id}">Sil</button>` : ""}
        </div>
      `).join("")}
    </div>
  `;

  el.querySelectorAll(".btn-sil").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Bu kasayı silmek istediğinize emin misiniz?")) return;
      await deleteDoc(doc(db, "kasalar", btn.dataset.id));
      kasaListesiYukle();
    });
  });
}


async function urunYonetimi(kapsayici) {
  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <button class="btn-geri" id="btn-yonetim-geri-urun">← Yönetim</button>
      <h2>Ürünler</h2>
    </div>
    <div class="yonetim-form-kart">
      <h3>Yeni Ürün Ekle</h3>
      <input type="text" id="urun-ad" placeholder="Ürün Adı (ör: Çay, Kola)" />
      <input type="number" id="urun-fiyat" placeholder="Fiyat (₺)" min="0" step="0.01" />
      <p id="urun-hata" class="hata gizli"></p>
      <button id="btn-urun-ekle" class="btn-birincil">Ekle</button>
    </div>
    <div id="urun-listesi">Yükleniyor...</div>
  `;

  elem("btn-yonetim-geri-urun").addEventListener("click", () => yonetimSayfasi(kapsayici));
  urunListesiYukle();

  elem("btn-urun-ekle").addEventListener("click", async () => {
    const hataEl = elem("urun-hata");
    hataEl.classList.add("gizli");
    const ad = elem("urun-ad").value.trim();
    const fiyat = parseFloat(elem("urun-fiyat").value);

    if (!ad) {
      hataEl.textContent = "Ürün adı gerekli.";
      hataEl.classList.remove("gizli");
      return;
    }
    if (isNaN(fiyat) || fiyat < 0) {
      hataEl.textContent = "Geçerli bir fiyat girin.";
      hataEl.classList.remove("gizli");
      return;
    }

    const btn = elem("btn-urun-ekle");
    btn.disabled = true;

    const snap = await getDocs(collection(db, "urunler"));
    const maxSira = snap.docs.reduce((max, d) => Math.max(max, d.data().sira ?? 0), -1);

    try {
      await addDoc(collection(db, "urunler"), { ad, fiyat, sira: maxSira + 1 });
      elem("urun-ad").value = "";
      elem("urun-fiyat").value = "";
      urunListesiYukle();
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
    }
    btn.disabled = false;
  });
}

async function urunListesiYukle() {
  const el = elem("urun-listesi");
  if (!el) return;

  const snap = await getDocs(query(collection(db, "urunler"), orderBy("sira")));
  const urunler = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  if (urunler.length === 0) {
    el.innerHTML = `<p class="bos-mesaj">Henüz ürün eklenmedi.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="yonetim-liste">
      ${urunler.map(u => `
        <div class="yonetim-liste-satir">
          <div>
            <div class="yonetim-liste-ad">${u.ad}</div>
            <div class="yonetim-liste-detay">${paraBicimlendir(u.fiyat)}</div>
          </div>
          <button class="btn-sil" data-id="${u.id}">Sil</button>
        </div>
      `).join("")}
    </div>
  `;

  el.querySelectorAll(".btn-sil").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Bu ürünü silmek istediğinize emin misiniz?")) return;
      await deleteDoc(doc(db, "urunler", btn.dataset.id));
      urunListesiYukle();
    });
  });
}


async function firmaYonetimi(kapsayici) {
  kapsayici.innerHTML = `
    <div class="sayfa-baslik">
      <button class="btn-geri" id="btn-yonetim-geri-firma">← Yönetim</button>
      <h2>Firma Bilgileri</h2>
    </div>
    <div class="yonetim-form-kart">
      <h3>Firma Adı</h3>
      <input type="text" id="firma-ad" placeholder="Firma Adı" value="${durum.firmaAdi}" style="text-transform:uppercase" />
      <p id="firma-hata" class="hata gizli"></p>
      <button id="btn-firma-kaydet" class="btn-birincil">Kaydet</button>
    </div>
  `;

  elem("firma-ad").addEventListener("input", function() {
    const s = this.selectionStart, e = this.selectionEnd;
    this.value = this.value.toUpperCase();
    this.setSelectionRange(s, e);
  });

  elem("btn-yonetim-geri-firma").addEventListener("click", () => yonetimSayfasi(kapsayici));

  elem("btn-firma-kaydet").addEventListener("click", async () => {
    const hataEl = elem("firma-hata");
    hataEl.classList.add("gizli");
    const ad = elem("firma-ad").value.trim();
    if (!ad) {
      hataEl.textContent = "Firma adı boş olamaz.";
      hataEl.classList.remove("gizli");
      return;
    }
    const btn = elem("btn-firma-kaydet");
    btn.disabled = true;
    try {
      await setDoc(doc(db, "sistem", "firma"), { ad }, { merge: true });
      durum.firmaAdi = ad;
      document.querySelectorAll(".ust-bar-logo").forEach(el => el.textContent = ad);
      btn.textContent = "Kaydedildi ✓";
      setTimeout(() => { btn.textContent = "Kaydet"; btn.disabled = false; }, 1500);
    } catch (err) {
      hataEl.textContent = "Hata: " + err.message;
      hataEl.classList.remove("gizli");
      btn.disabled = false;
    }
  });
}


// ============================================================
// 18. BAŞLATICI
// Sayfa yüklenince kimlik durumunu dinler.
// Oturum açıksa layout'u, kapalıysa giriş ekranını gösterir.
// ============================================================

onAuthStateChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    girisEkraniGoster();
    return;
  }

  const snap = await getDoc(doc(db, "kullanicilar", firebaseUser.uid));
  if (!snap.exists()) {
    await signOut(auth);
    girisEkraniGoster();
    return;
  }

  durum.kullanici = { uid: firebaseUser.uid, ...snap.data() };

  const firmaSnap = await getDoc(doc(db, "sistem", "firma"));
  if (firmaSnap.exists() && firmaSnap.data().ad) durum.firmaAdi = firmaSnap.data().ad;
  document.title = durum.firmaAdi;

  if (durum.kullanici.rol === "oyuncu") {
    oyuncuLayoutGoster();
  } else {
    layoutGoster();
  }
});
