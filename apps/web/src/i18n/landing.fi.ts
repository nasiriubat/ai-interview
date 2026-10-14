import type { LandingStrings } from "./landing.en";

/**
 * Julkinen aloitussivu (`/`), suomeksi. Kirjoitettu suomeksi, ei käännetty sanasta sanaan:
 * sinuttelu, lyhyet otsikot, sanasto `docs/design/glossary.md`:n mukaan. Väitteet ovat samat kuin
 * englanninkielisessä tiedostossa ja ne tarkistetaan `docs/team/claims-2026-10.md`:ää vasten.
 */
export const landingFi: LandingStrings = {
  meta: {
    titleTail: "Ymmärrä ongelma ennen kuin päätät, mitä rakennat",
    description:
      "Työntekijöiden jäsennellyistä haastatteluista syntyy pisteytetty kartta siitä, missä työ takkuaa. Mistä tahansa mahdollisuudesta tai ideasta syntyy versioitu määrittely, jonka kehittäjäsi tai koodausagenttisi voi toteuttaa.",
  },
  nav: {
    label: "Tällä sivulla",
    paths: "Kaksi haastattelua",
    how: "Näin se toimii",
    chatbot: "Miksei chatbotti",
    trust: "Luottamus",
    faq: "Kysymyksiä",
  },
  header: { signIn: "Kirjaudu", dashboard: "Siirry yleiskatsaukseen" },
  hero: {
    eyebrow: "Organisaatioille, jotka haluavat tietää ennen kuin rakentavat",
    title: "Ymmärrä ongelma ennen kuin päätät, mitä rakennat.",
    lead: "Työntekijöiden jäsennellyistä haastatteluista syntyy pisteytetty kartta siitä, missä työ takkuaa ja mitä pitäisi muuttaa, jos mitään. Mistä tahansa mahdollisuudesta tai ideasta tulee määrittely, jonka kehittäjäsi tai koodausagenttisi voi toteuttaa. Palvelu on tehty toimimaan omalla palvelimellasi ja sinun asettamillasi säännöillä.",
    requestWorkspace: "Pyydä työtila",
    signIn: "Kirjaudu",
    dashboard: "Siirry yleiskatsaukseen",
    noContact: "Työtilat luo tämän palvelun ylläpitäjä. Kysy heiltä tai kirjaudu, jos sinulla on jo työtila.",
    small: [
      "Osallistujat eivät tarvitse tiliä",
      "Tehty toimimaan yhdellä omalla palvelimella",
      "Jokainen mallikutsu kirjataan hintoineen",
    ],
  },
  participant: {
    heading: "Sait haastattelulinkin?",
    body: "Et tarvitse tiliä etkä mitään tältä sivulta. Avaa kutsussa oleva linkki. Siinä kerrotaan, kuka kysyy ja miksi, mitä tallennetaan ja miten voit poistaa vastauksesi.",
    points: [
      "Kirjoita, valitse vaihtoehtoja tai puhu, jos organisaatiosi on ottanut puheen käyttöön.",
      "Voit keskeyttää milloin tahansa ja palata samalla linkillä.",
      "Raportissa lainaus näkyy vain, jos riittävän moni sanoi jotain samankaltaista: oletuksena vähintään kolme.",
    ],
  },
  paths: {
    heading: "Kaksi haastattelua ja silta niiden välillä",
    intro:
      "Voit käyttää kumpaa tahansa erikseen. Tai aloittaa ihmisistä ja viedä heidän sanomansa rakentamiseen asti.",
    discovery: {
      kicker: "Kartoitushaastattelut",
      audience: "HR-, toiminta- ja muutosjohdolle",
      title: "Selvitä, miten työ oikeasti tehdään",
      paragraphs: [
        "Kutsu ihmiset linkillä. Jokainen keskustelee tekstillä, vaihtoehdoilla tai puheella siitä, miten hänen työnsä oikeasti tehdään: rooli, päivittäiset tehtävät, toistuva työ, työkalut, käsityövaiheet, luovutukset, pullonkaulat ja ongelmat. Haastattelija kysyy yhden kysymyksen kerrallaan, menee yhden tason syvemmälle, kun jokin prosessi tulee esiin, ja sille on ohjeistettu, ettei se koskaan kysy, mihin tekoälyä pitäisi käyttää.",
        "Kun tarpeeksi moni on vastannut, haastattelut analysoidaan yhdessä. Samankaltaiset tehtävät ja ongelmat ryhmitellään, lasketaan ja pisteytetään seitsemällä tekijällä: vaikutus, kuinka monta ihmistä koskee, toistuvuus, yksinkertaisuus, datan saatavuus, riski ja sopivuus tekoälylle. Jokainen mahdollisuus luokitellaan tekoälyksi, automaatioksi, ohjelmistoksi, toimintatavan muutokseksi tai ei muutosta suositella.",
        "Saat raportin: tiivistelmä, työn kartta, osastovertailu, mahdollisuudet ratkaisuluokittain, nopeat voitot ja strategiset panostukset, missä tekoäly ei ole vastaus sekä seuraavat askeleet.",
      ],
    },
    bridge: {
      kicker: "Silta",
      title: "Mahdollisuudesta vaatimushaastatteluun",
      body: "Valitse mahdollisuus ja aloita siitä vaatimushaastattelu. Ensimmäisen kierroksen oppi siirtyy lähtötiedoiksi, joten toinen haastattelu kysyy vain sen, mikä vielä puuttuu.",
    },
    requirements: {
      kicker: "Vaatimushaastattelut",
      audience: "Tuotteen omistajille, teknologiajohtajille, perustajille ja konsulteille",
      title: "Tee ideasta jotain, minkä kehittäjä voi rakentaa",
      paragraphs: [
        "Aloita yhdestä lauseesta tai löydetystä mahdollisuudesta ja liitä asiakirjoja mukaan matkan varrella. Kerro, oletko tekninen vai et. Haastattelija selvittää ensin taustan: palvelinympäristö, nykyiset järjestelmät, kuka rakentaa, tiimin osaaminen, aikataulu, budjetti, käyttäjät julkaisussa ja vaatimustenmukaisuus. Sitten se käy läpi käyttäjät, tarinat, vaatimukset, säännöt, datan, integraatiot, tietoturvan, ylläpitonäkymän, ensimmäisen version, myöhemmän laajuuden ja vaiheet. Yksi päätös kysymystä kohden, ja jokaiselle perustelu ja oletus.",
        "Viiden vuoron välein erillinen läpikäynti tarkistaa määrittelystä epäselvyydet, ristiriidat, puuttuvat päätökset ja tarpeettoman monimutkaisuuden ja nostaa esiin yhden havainnon kerrallaan. Ennen lopetusta se käy läpi ensimmäisen version listasi ja kysyy jokaisesta, mikä hajoaa, jos versio yksi julkaistaan ilman sitä.",
        "Saat versioidun määrittelyn: luettavan asiakirjan, koneluettavan tiedoston ja Claude Codelle tai Codexille tehdyn paketin, jossa on tausta, vaihesuunnitelma ja tehtävätiedosto jokaiselle vaiheelle hyväksymiskriteereineen. Avaa se myöhemmin uudelleen ja näe, mikä versioiden välillä muuttui.",
      ],
    },
  },
  how: {
    heading: "Näin se toimii",
    discovery: {
      title: "Kartoitushaastattelut",
      steps: [
        {
          title: "Luo kampanja mallipohjasta",
          body: "Valitse omalla nimellä, anonyymisti tai osallistujan oma valinta. Kirjoita suostumusteksti ja päätä, kuka saa lukea keskustelut. Esikatsele haastattelu itse ennen lähettämistä.",
        },
        {
          title: "Jaa yksi linkki tai lähetä kutsut",
          body: "Osallistujat voivat vahvistaa sähköpostinsa kerran, jotta jokainen vastaa vain kerran. Anonyymeissä kampanjoissa sähköpostia ei tallenneta vastausten mukana.",
        },
        {
          title: "Ihmiset vastaavat",
          body: "Puhelimella tai selaimessa, ilman sovellusta ja tiliä. Kirjoita, valitse vaihtoehto, nauhoita vastaus tai puhu, jos puhe on otettu käyttöön. Liitä tarvittaessa asiakirja. Keskeytä ja palaa: vastaukset tallentuvat sitä mukaa kuin ne annetaan.",
        },
        {
          title: "Lue raportti",
          body: "Analyysi käynnistyy, kun valmistumisraja täyttyy tai kun käynnistät sen itse. Yhdistä, jaa tai nimeä ryhmiä uudelleen, säädä painoja, piilota osioita, lataa raportti Markdownina tai PDF:nä ja vie rakentamisen arvoiset mahdollisuudet vaatimushaastatteluun.",
        },
      ],
    },
    requirements: {
      title: "Vaatimushaastattelut",
      steps: [
        {
          title: "Kuvaa idea",
          body: "Yksi lause riittää. Liitä mukaan, mitä sinulla on, tai aloita löydetystä mahdollisuudesta ja ohita se, mikä jo tiedetään.",
        },
        {
          title: "Selvitä tausta ensin",
          body: "Kahdeksan kysymystä palvelinympäristöstä, rakentajista, osaamisesta, aikataulusta, budjetista, mittakaavasta ja vaatimustenmukaisuudesta ohjaavat jokaista myöhempää kysymystä ja oletusta.",
        },
        {
          title: "Päätä yksi kysymys kerrallaan",
          body: "Jokainen kysymys kertoo, miksi se on tärkeä, ja tarjoaa oletuksen, jonka voit hyväksyä yhdellä sanalla. Havainnot nostetaan esiin sitä mukaa kuin niitä syntyy; haastattelija huomauttaa kerran ja kirjaa sitten valintasi.",
        },
        {
          title: "Ota määrittely mukaasi",
          body: "Lataa määrittely ja agenttipaketti. Jokainen versio säilyy; haastattelun uudelleenavaus luo seuraavan version ja näyttää, mikä muuttui.",
        },
      ],
    },
  },
  chatbot: {
    heading: "Miksei vain chatbotti?",
    intro: "Voit pyytää chatbottia haastattelemaan tiimiäsi. Tässä, mitä saat sen sijaan.",
    tableCaption: "Chat-ikkuna verrattuna tähän palveluun",
    columnChat: "Chat-ikkunassa",
    columnHere: "Täällä",
    rows: [
      {
        chat: "Yksi keskustelu kerrallaan, jokainen vähän erilainen",
        here: "Sama haastattelu jokaiselle osallistujalle, mallipohjasta jonka versio lukitaan kampanjalle",
      },
      {
        chat: "Yksi keskustelu per ihminen, jonka joku lukee",
        here: "Kiinteän rakenteen mukaan poimitut asiat, ryhmiteltynä ja laskettuna koko kampanjan yli",
      },
      {
        chat: "Anonymiteetti lupauksena",
        here: "Lainaus, rooli tai osasto näkyy vain, kun vähintään kolme ihmistä on sen takana. Sääntö on asetus ja se tulostetaan raporttiin",
      },
      {
        chat: "Malli, joka haluaa auttaa rakentamaan jotain",
        here: "Analyysi, joka voi päätyä tulokseen ei muutosta suositella, ja kertoo miksi",
      },
      {
        chat: "Asiakirja",
        here: "Versioitu määrittely, jossa on numeroidut vaatimukset, hyväksymiskriteerit, vaiheistetut tehtävät ja versioiden välinen vertailu",
      },
      {
        chat: "Mitä toimittajan säilytyskäytäntö sattuu sanomaan",
        here: "Oma palvelin, valitsemasi mallintarjoajat, kirjanpito jokaisesta kutsusta, auditointiloki ylläpitäjien toimista, poisto pyynnöstä ja automaattiset säilytysrajat",
      },
    ],
    justAsWellHeading: "Mitä chatbotti tekee yhtä hyvin",
    justAsWell:
      "Ensiluonnoksen, kun ihmisiä on yksi ja ideoita yksi, sekä hyvää tekstiä. Raportin lauseet tulevat samanlaiselta mallilta; ero on siinä, mitä sisään menee (jäsenneltyjä poimintoja, määriä, anonymiteettisääntö) ja mitä ulos tulevalle tehdään (tarkistukset, versiot, vertailut). Jos tarvitset luonnoksen tälle illalle, käytä chatbottia. Palaa, kun idean pitää kestää kolmekymmentä työtoveria tai yksi koodausagentti.",
  },
  trust: {
    heading: "Mihin voit luottaa",
    intro: "Jokainen näistä on ohjelmiston toimintaa, ei käytännön lupaus.",
    items: [
      {
        title: "Yksityisyys",
        body: "Osallistujat eivät tarvitse tiliä. Suostumusteksti on sinun kirjoittamasi, ja jokaisen hyväksymä versio kirjataan. Se, kuka saa avata keskustelut sellaisenaan, on asetus; oletuksena ylläpitäjät voivat lukea keskustelun vain, kun osallistuja valitsi esiintyä omalla nimellään ja suostui.",
      },
      {
        title: "Anonymiteetti",
        body: "Anonyymeissä kampanjoissa sähköpostilla varmistetaan, että jokainen vastaa vain kerran, ja kampanjaan jää vain sen suolattu tiiviste, joka ei yhdisty vastauksiin. Lainaus, rooli tai osasto näkyy raportissa vain, kun vähintään kolme osallistujaa on sen takana. Kolme on oletus; luvun asettaa organisaatiosi.",
      },
      {
        title: "Palvelin ja palveluntarjoajat",
        body: "Palvelu on tehty toimimaan yhdellä palvelimella, jota itse ylläpidät valitsemassasi maassa ja jonka rajapinta ei ole avoimessa internetissä. Mallikutsut menevät vain organisaatiosi määrittämille palveluntarjoajille, tehtävittäin: ulkoiselle palvelulle tai itse ylläpitämällesi OpenAI-yhteensopivalle päätepisteelle. Äänitteet voi litteroida samalla palvelimella. Jotkin ulkoiset palveluntarjoajat käsittelevät tietoa EU:n ulkopuolella, ja palvelu listaa jokaisen tarjoajan ja sen käsittelypaikan.",
      },
      {
        title: "Sinun tietosi",
        body: "Osallistuja voi poistaa vastauksensa, äänitteensä ja tiedostonsa haastattelun valikosta, ja hänen antamansa nimi ja sähköposti poistuvat samalla. Hän voi myös ladata omat tietonsa. Muiden vastausten kanssa jo yhdistetyt summat säilyvät, eikä niitä voi jäljittää häneen. Haastattelutiedot poistetaan automaattisesti asettamasi säilytysajan jälkeen, oletuksena 24 kuukauden kuluttua. Ylläpitäjien toimet kirjataan auditointilokiin, johon voi vain lisätä.",
      },
      {
        title: "Kustannukset näkyvissä",
        body: "Jokainen mallikutsu kirjataan tehtävineen, palveluntarjoajineen, malleineen, tokeneineen ja hintoineen. Budjetit on organisaatiolle, kampanjalle ja yksittäiselle haastattelulle. Ylläpitäjiä varoitetaan ennen kuin budjetti loppuu, ja loppuneen budjetin haastattelu keskeytyy näkyvästi. Kulutus näytetään kampanjoittain ja tehtävittäin.",
      },
    ],
  },
  audience: {
    heading: "Kenelle tämä on",
    items: [
      {
        title: "HR- ja toimintajohto",
        body: "Haluat tietää, mihin aika menee, ennen seuraavaa työkalupäätöstä, ja haluat ihmisten pystyvän puhumaan suoraan.",
      },
      {
        title: "Teknologiajohtajat ja digijohto",
        body: "Sinulta kysytään, mitä tekoälyllä pitäisi tehdä, ja haluat vastauksen, joka voi olla ei mitään.",
      },
      {
        title: "Konsultit",
        body: "Teet asiakkaille kartoitusta. Jokainen asiakas voi olla oma organisaationsa omine mallipohjineen, mallintarjoajineen, budjetteineen ja raportteineen.",
      },
      {
        title: "Tuotteen omistajat",
        body: "Sinulla on idea ja kehittäjä odottamassa, ja haluat kysymykset esitettäväksi ennen sprinttiä, et sen aikana.",
      },
      {
        title: "Kehittäjät ja koodausagentit",
        body: "Saat mieluummin numeroidut vaatimukset, hyväksymiskriteerit ja vaihesuunnitelman kuin esityskalvot.",
      },
    ],
  },
  faq: {
    heading: "Kysymyksiä",
    items: [
      {
        q: "Enkö voi käyttää vain ChatGPT:tä?",
        a: "Yhden ihmisen yhden idean luonnosteluun voi, ja luonnos on kelvollinen. Tämä on tarkoitettu tilanteisiin, joissa monta ihmistä pitää haastatella samalla tavalla, kenenkään sanoja ei saa paljastaa, vastaus voi olla älä rakenna tätä ja lopputuloksen pitää olla versioitu määrittely, jonka kehittäjä tai agentti voi toteuttaa. Yllä oleva vertailu on rehellinen versio.",
      },
      {
        q: "Onko se anonyymi?",
        a: "Voi olla. Kampanjan omistaja valitsee omalla nimellä, anonyymisti tai antaa osallistujan valita. Anonyymissa tilassa sähköpostilla varmistetaan yksi vastaus per ihminen, ja kampanjaan jää vain suolattu tiiviste, joka ei yhdisty haastatteluun. Raportissa lainaukset ja jaottelut näkyvät vain, kun vähintään kolme ihmistä on niiden takana.",
      },
      {
        q: "Missä tietoni ovat?",
        a: "Palvelua ylläpitävän organisaation omalla palvelimella; vakiototeutus on yksi EU-palvelin. Haastatteluteksti menee vain niille mallintarjoajille, jotka organisaatio on määrittänyt: ulkoisille palveluille tai itse ylläpidetylle päätepisteelle. Jotkin ulkoiset tarjoajat käsittelevät tietoa EU:n ulkopuolella, joten tarjoajalistalla on väliä. Äänitteet voi litteroida samalla palvelimella, kun paikallinen litterointi on otettu käyttöön.",
      },
      {
        q: "Päättääkö tekoäly, mitä meidän pitäisi rakentaa?",
        a: "Ei. Kartoitushaastattelija on ohjeistettu, ettei se koskaan kysy, mihin tekoälyä pitäisi käyttää, eikä ehdota ratkaisuja. Analyysi pisteyttää jokaisen mahdollisuuden ja voi luokitella sen ei muutosta suositella, perusteluineen. Vaatimushaastattelu tarjoaa oletuksia; sinä päätät, ja päätöksesi kirjataan.",
      },
      {
        q: "Mitä kehittäjät saavat?",
        a: "Määrittelyn Markdownina ja JSONina: numeroidut vaatimukset, joista jokainen on merkitty ensimmäiseen versioon tai myöhemmäksi ja sisältää hyväksymiskriteerit; liiketoimintasäännöt; tekniset päätökset; tietokohteet; integraatiot; ylläpitonäkymä; avoimet kysymykset oletuksineen; sekä toteutusvaiheet. Lisäksi paketin Claude Codelle tai Codexille: agentin ohje, vaihesuunnitelma ja tehtävätiedosto jokaiselle vaiheelle. Versiot säilyvät ja niitä voi verrata.",
      },
      {
        q: "Mitä se maksaa?",
        a: "Kaksi osaa: palvelu, jota ylläpidät itse tai jonka ylläpidon ostat, sekä mallien käyttö. Jokainen kutsu kirjataan hintoineen, ja asetat budjetit organisaatiolle, kampanjalle ja yksittäiselle haastattelulle. Sisäisessä testissä kahdeksalla simuloidulla haastateltavalla ja edullisilla malleilla yhden haastattelun mallikäyttö maksoi 1,4–2,2 senttiä. Se on testiluku, ei tarjous; sinun mallisi ja haastattelusi voivat poiketa.",
      },
      {
        q: "Kuinka kauan haastattelu kestää?",
        a: "Se päättyy, kun aihealueet on käyty läpi, kun osallistuja sanoo olevansa valmis tai kun vuorojen enimmäismäärä tulee vastaan; kartoituspohjassa se on 60 vuoroa. Testiajoissamme haastattelut kestivät 20–24 vuoroa. Osallistuja voi keskeyttää ja palata samalle linkille.",
      },
      {
        q: "Voimmeko muuttaa kysymyksiä?",
        a: "Kyllä. Haastattelu on mallipohja: aihealueet valmis-kun-kriteereineen, ohjeet, jatkokysymysten rajat, vastausvaihtoehdot, yksityisyystila ja tulosteet. Kopioi vakiomallipohja, muokkaa sitä, esikatsele se kokeiluhaastatteluna ja julkaise versio. Kampanja pysyy sillä versiolla, jolla se alkoi.",
      },
      {
        q: "Entä jos joku vastaa yhdellä sanalla tai eksyy aiheesta?",
        a: "Haastattelija siirtyy konkreettisiin kysymyksiin ja vastausvaihtoehtoihin, ja kolmen minimaalisen vastauksen jälkeen se lyhentää haastattelun olennaisiin aihealueisiin. Aiheen vierestä tulevat huomautukset kuitataan ja jätetään odottamaan. Jos joku vaikuttaa ahdistuneelta, haastattelija lopettaa tiedustelun ja merkitsee haastattelun järjestäjälle tallentamatta arviota henkilöstä.",
      },
      {
        q: "Kuka voi lukea keskustelut?",
        a: "Se on asetus. Oletuksena ylläpitäjät, ja vain kun osallistuja valitsi esiintyä omalla nimellään ja suostui. Jäsenet näkevät yhdistetyt tulokset. Osallistuja näkee oman yhteenvetonsa lopuksi ja voi korjata sitä.",
      },
    ],
  },
  cta: {
    heading: "Aja ensimmäinen kampanja muutaman työtoverin kanssa",
    body: "Pyydä työtila, aloita vakiona tulevasta kartoituspohjasta, esikatsele se itselläsi ja kutsu kourallinen työtovereita. Ensimmäinen raportti kertoo, kannattaako laajempi kierros.",
    request: "Pyydä työtila",
    signIn: "Kirjaudu",
    dashboard: "Siirry yleiskatsaukseen",
    consultancy:
      "Teetkö kartoitusta asiakkaille? Jokainen asiakas voi olla oma organisaationsa omine mallipohjineen, mallintarjoajineen, budjetteineen ja raportteineen. Kysy ylläpitäjän käyttöoikeuksista.",
  },
  footer: {
    note: "Tällä sivulla ei ole seurantaa, eikä se tee pyyntöjä muille sivustoille. Kieli- ja ulkoasuvalintasi pysyvät selaimessasi.",
    signIn: "Kirjaudu",
  },
  mailto: {
    subject: "Työtilapyyntö",
    body: "Hei,\n\nHaluaisin pyytää työtilan.\n\nOrganisaatio:\nMitä haluamme selvittää:\n",
  },
};
