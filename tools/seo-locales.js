/* ============================================================================
 * Translated SEO landing pages (used by tools/gen-seo.js).
 * Searches in other languages have far less competition than English ones, so
 * the three pages that match SameCouch best — couples, families abroad, friends —
 * also exist in nl/de/es/fr/pt, each under a slug in its own language, linked to
 * each other with hreflang.
 * ==========================================================================*/
"use strict";

/* page chrome per language */
const LOCALES = {
  en: { name: "English", cta: "Create your private room — it's free", ctasub: "No app · No sign-up · Works on any phone", faq: "Frequently asked questions", cta2: "Start watching together now", more: "More ways to be together", also: "Also in", privacy: ["Privacy", "/privacy.html"], terms: ["Terms", "/terms.html"] },
  nl: { name: "Nederlands", cta: "Maak je eigen kamer — gratis", ctasub: "Geen app · Geen account · Werkt op elke telefoon", faq: "Veelgestelde vragen", cta2: "Begin nu met samen kijken", more: "Meer manieren om samen te zijn", also: "Ook in", privacy: ["Privacy", "/privacy-nl.html"], terms: ["Voorwaarden", "/terms-nl.html"] },
  de: { name: "Deutsch", cta: "Erstelle deinen privaten Raum — kostenlos", ctasub: "Keine App · Keine Anmeldung · Läuft auf jedem Handy", faq: "Häufige Fragen", cta2: "Jetzt zusammen schauen", more: "Mehr Wege, zusammen zu sein", also: "Auch auf", privacy: ["Datenschutz", "/privacy.html"], terms: ["Nutzungsbedingungen", "/terms.html"] },
  es: { name: "Español", cta: "Crea tu sala privada — es gratis", ctasub: "Sin app · Sin registro · Funciona en cualquier móvil", faq: "Preguntas frecuentes", cta2: "Empieza a ver juntos ahora", more: "Más formas de estar juntos", also: "También en", privacy: ["Privacidad", "/privacy.html"], terms: ["Términos", "/terms.html"] },
  fr: { name: "Français", cta: "Créez votre salon privé — c'est gratuit", ctasub: "Sans appli · Sans inscription · Fonctionne sur tous les téléphones", faq: "Questions fréquentes", cta2: "Commencez à regarder ensemble", more: "D'autres façons d'être ensemble", also: "Aussi en", privacy: ["Confidentialité", "/privacy.html"], terms: ["Conditions", "/terms.html"] },
  pt: { name: "Português", cta: "Crie sua sala privada — é grátis", ctasub: "Sem app · Sem cadastro · Funciona em qualquer celular", faq: "Perguntas frequentes", cta2: "Comece a assistir juntos agora", more: "Mais formas de estar juntos", also: "Também em", privacy: ["Privacidade", "/privacy.html"], terms: ["Termos", "/terms.html"] }
};

/* shared blocks per language */
const COMMON = {
  nl: {
    what: { h2: "Wat is SameCouch?", paras: [
      "SameCouch is een privé-huiskamer in je browser voor mensen die ver van elkaar wonen. Je kijkt YouTube, Vimeo, je eigen video's of gratis klassieke films perfect gelijk, je ziet en hoort elkaar in kleine zwevende camerabubbels, je reageert met emoji en je laat foto's en berichtjes achter op een gedeelde herinneringenmuur die er de volgende keer nog staat.",
      "Er is geen app om te installeren en geen account om aan te maken. Je maakt met één klik een kamer, stuurt de link via WhatsApp, en jullie zitten samen — meestal binnen tien seconden." ] },
    private: { q: "Is het privé?", a: "Ja. Kamers bestaan alleen voor mensen met de link, de host kan een wachtwoord instellen, en videogesprekken zijn versleuteld van apparaat tot apparaat — als een directe verbinding niet lukt, gaan ze via onze doorgifteserver, die ze niet kan lezen." },
    free: { q: "Is SameCouch gratis?", a: "Ja, helemaal. Kamers, videobellen, samen kijken, chat en de herinneringenmuur zijn allemaal gratis — geen abonnement, geen betalingen. Je herinneringen blijven bewaard tot 12 maanden nadat de kamer voor het laatst is gebruikt." },
    app: { q: "Moet ik iets installeren?", a: "Nee. Het werkt in de browser op elke telefoon, tablet of computer — geen extensie, geen app, geen account. Open gewoon de link." },
    people: { q: "Hoeveel mensen kunnen meedoen?", a: "Tot 8 mensen in één kamer — genoeg voor een hele familieavond of een filmavond met vrienden in verschillende landen." }
  },
  de: {
    what: { h2: "Was ist SameCouch?", paras: [
      "SameCouch ist ein privates Wohnzimmer in deinem Browser für Menschen, die weit voneinander entfernt sind. Ihr schaut YouTube, Vimeo, eigene Videos oder kostenlose Filmklassiker perfekt synchron, seht und hört euch in kleinen schwebenden Kamerablasen, reagiert mit Emojis und hinterlasst Fotos und Notizen an einer gemeinsamen Erinnerungswand, die beim nächsten Mal noch da ist.",
      "Es gibt keine App zu installieren und kein Konto anzulegen. Du erstellst mit einem Klick einen Raum, schickst den Link per WhatsApp, und ihr seid zusammen — meist in unter zehn Sekunden." ] },
    private: { q: "Ist es privat?", a: "Ja. Räume gibt es nur für Menschen mit dem Link, der Host kann ein Passwort setzen, und Videoanrufe sind von Gerät zu Gerät verschlüsselt — wenn keine direkte Verbindung möglich ist, laufen sie über unseren Relay-Server, der sie nicht lesen kann." },
    free: { q: "Ist SameCouch kostenlos?", a: "Ja, komplett. Räume, Videoanrufe, gemeinsames Schauen, Chat und die Erinnerungswand sind alle kostenlos — keine Abos, keine Zahlungen. Eure Erinnerungen bleiben bis 12 Monate nach der letzten Nutzung des Raums gespeichert." },
    app: { q: "Muss ich etwas installieren?", a: "Nein. Es läuft im Browser auf jedem Handy, Tablet oder Computer — keine Erweiterung, keine App, keine Anmeldung. Einfach den Link öffnen." },
    people: { q: "Wie viele Leute können mitmachen?", a: "Bis zu 8 Personen in einem Raum — genug für einen ganzen Familienabend oder einen Filmabend mit Freunden in verschiedenen Ländern." }
  },
  es: {
    what: { h2: "¿Qué es SameCouch?", paras: [
      "SameCouch es una sala de estar privada en tu navegador para personas que están lejos. Ven YouTube, Vimeo, sus propios vídeos o películas clásicas gratuitas perfectamente sincronizados, se ven y se oyen en pequeñas burbujas de cámara flotantes, reaccionan con emojis y dejan fotos y notas en un muro de recuerdos compartido que sigue ahí la próxima vez.",
      "No hay que instalar ninguna app ni crear ninguna cuenta. Creas una sala con un clic, envías el enlace por WhatsApp y ya están juntos — normalmente en menos de diez segundos." ] },
    private: { q: "¿Es privado?", a: "Sí. Las salas solo existen para quien tiene el enlace, el anfitrión puede poner una contraseña y las videollamadas están cifradas de dispositivo a dispositivo — cuando no es posible una conexión directa pasan por nuestro servidor de retransmisión, que no puede leerlas." },
    free: { q: "¿SameCouch es gratis?", a: "Sí, totalmente. Las salas, las videollamadas, ver juntos, el chat y el muro de recuerdos son gratis — sin suscripciones ni pagos. Tus recuerdos se guardan hasta 12 meses después del último uso de la sala." },
    app: { q: "¿Tengo que instalar algo?", a: "No. Funciona en el navegador de cualquier móvil, tableta u ordenador — sin extensión, sin app, sin registro. Solo abre el enlace." },
    people: { q: "¿Cuántas personas pueden unirse?", a: "Hasta 8 personas en una sala — suficiente para una noche familiar entera o una noche de cine con amigos en distintos países." }
  },
  fr: {
    what: { h2: "Qu'est-ce que SameCouch ?", paras: [
      "SameCouch est un salon privé dans votre navigateur pour les personnes qui vivent loin les unes des autres. Vous regardez YouTube, Vimeo, vos propres vidéos ou des classiques du cinéma gratuits parfaitement synchronisés, vous vous voyez et vous entendez dans de petites bulles de caméra flottantes, vous réagissez avec des emojis et vous laissez des photos et des mots sur un mur de souvenirs partagé, toujours là la fois suivante.",
      "Aucune appli à installer, aucun compte à créer. Vous créez un salon en un clic, envoyez le lien sur WhatsApp, et vous voilà ensemble — généralement en moins de dix secondes." ] },
    private: { q: "Est-ce privé ?", a: "Oui. Les salons n'existent que pour les personnes qui ont le lien, l'hôte peut définir un mot de passe, et les appels vidéo sont chiffrés d'appareil à appareil — quand une connexion directe est impossible, ils passent par notre serveur relais, qui ne peut pas les lire." },
    free: { q: "SameCouch est-il gratuit ?", a: "Oui, entièrement. Les salons, les appels vidéo, le visionnage ensemble, le chat et le mur de souvenirs sont gratuits — sans abonnement ni paiement. Vos souvenirs sont conservés jusqu'à 12 mois après la dernière utilisation du salon." },
    app: { q: "Dois-je installer quelque chose ?", a: "Non. Tout fonctionne dans le navigateur de n'importe quel téléphone, tablette ou ordinateur — sans extension, sans appli, sans inscription. Ouvrez simplement le lien." },
    people: { q: "Combien de personnes peuvent participer ?", a: "Jusqu'à 8 personnes dans un salon — assez pour toute une soirée en famille ou une soirée ciné entre amis dans différents pays." }
  },
  pt: {
    what: { h2: "O que é o SameCouch?", paras: [
      "O SameCouch é uma sala de estar privada no seu navegador para pessoas que estão longe. Vocês assistem YouTube, Vimeo, seus próprios vídeos ou clássicos do cinema gratuitos em perfeita sincronia, se veem e se ouvem em pequenas bolhas de câmera flutuantes, reagem com emojis e deixam fotos e recados num mural de lembranças compartilhado que continua lá da próxima vez.",
      "Não há app para instalar nem conta para criar. Você cria uma sala com um clique, envia o link pelo WhatsApp e vocês estão juntos — normalmente em menos de dez segundos." ] },
    private: { q: "É privado?", a: "Sim. As salas só existem para quem tem o link, o anfitrião pode definir uma senha e as chamadas de vídeo são criptografadas de aparelho para aparelho — quando uma conexão direta não é possível, elas passam pelo nosso servidor de retransmissão, que não consegue lê-las." },
    free: { q: "O SameCouch é grátis?", a: "Sim, totalmente. Salas, chamadas de vídeo, assistir juntos, chat e o mural de lembranças são grátis — sem assinatura, sem pagamentos. Suas lembranças ficam guardadas até 12 meses depois do último uso da sala." },
    app: { q: "Preciso instalar alguma coisa?", a: "Não. Funciona no navegador de qualquer celular, tablet ou computador — sem extensão, sem app, sem cadastro. É só abrir o link." },
    people: { q: "Quantas pessoas podem participar?", a: "Até 8 pessoas numa sala — o suficiente para uma noite inteira em família ou uma noite de cinema com amigos em países diferentes." }
  }
};

/* the translated pages, keyed by the English slug they translate */
function pages() {
  const C = COMMON;
  return {
    "long-distance-movie-night": {
      nl: { slug: "samen-film-kijken-op-afstand", title: "Samen film kijken op afstand — filmavond met je lief | SameCouch",
        desc: "Een echte filmavond met je partner op afstand: video perfect gelijk, jullie gezichten over de film, emoji-reacties en een gedeelde herinneringenmuur. Gratis.",
        kicker: "Voor stellen op afstand", h1: "Filmavond met je lief op afstand",
        intro: ["Het moeilijkste aan een relatie op afstand zijn niet de grote dingen — het zijn de gewone avonden die je niet samen hebt. Filmavond is de makkelijkste om terug te pakken.",
          "Open jullie kamer, druk samen op play en zie elkaar lachen in de hoek van het scherm. Laat daarna een berichtje of foto achter op jullie muur — die staat er bij de volgende date nog."],
        sections: [{ h2: "Maak er een ritueel van", bullets: ["Plan jullie filmavond, dan krijgen jullie allebei een herinnering.", "Na de film plan je met één tik dezelfde tijd volgende week.", "Houd één vaste kamerlink — die wordt 'jullie plek'.", "Laat tussen de dates door berichtjes achter op de herinneringenmuur."] }, C.nl.what],
        faq: [C.nl.private, C.nl.free, C.nl.app] },
      de: { slug: "filmabend-fernbeziehung", title: "Filmabend in der Fernbeziehung — Date Night auf jede Distanz | SameCouch",
        desc: "Ein echter Filmabend mit deinem Partner in der Fernbeziehung: synchrones Video, eure Gesichter über dem Film, Emoji-Reaktionen und eine gemeinsame Erinnerungswand. Kostenlos.",
        kicker: "Für Paare auf Distanz", h1: "Filmabend in der Fernbeziehung",
        intro: ["Das Schwerste an einer Fernbeziehung sind nicht die großen Dinge — es sind die ganz normalen Abende, die ihr nicht teilen könnt. Der Filmabend ist der einfachste, den ihr euch zurückholen könnt.",
          "Öffnet euren Raum, drückt gemeinsam auf Play und seht euch in der Ecke des Bildschirms lachen. Hinterlasst danach eine Notiz oder ein Foto an eurer Wand — beim nächsten Date ist es noch da."],
        sections: [{ h2: "Macht ein Ritual daraus", bullets: ["Plant euren Filmabend, dann bekommt ihr beide eine Erinnerung.", "Nach dem Film plant ihr mit einem Tipp dieselbe Zeit nächste Woche.", "Behaltet einen festen Raum-Link — er wird zu 'eurem Ort'.", "Hinterlasst zwischen den Dates Notizen an der Erinnerungswand."] }, C.de.what],
        faq: [C.de.private, C.de.free, C.de.app] },
      es: { slug: "noche-de-cine-a-distancia", title: "Noche de cine a distancia — una cita para parejas a distancia | SameCouch",
        desc: "Una noche de cine de verdad con tu pareja a distancia: vídeo sincronizado, sus caras sobre la película, reacciones con emojis y un muro de recuerdos compartido. Gratis.",
        kicker: "Para parejas a distancia", h1: "Noche de cine con tu amor a distancia",
        intro: ["Lo más difícil de la distancia no son las grandes cosas — son las noches normales que no pueden compartir. La noche de cine es la más fácil de recuperar.",
          "Abran su sala, denle a play juntos y mírense reír en la esquina de la pantalla. Después, dejen una nota o una foto en su muro — seguirá ahí en la próxima cita."],
        sections: [{ h2: "Conviértanlo en un ritual", bullets: ["Planifiquen su noche de cine y ambos recibirán un recordatorio.", "Al terminar la película, planifiquen la misma hora la próxima semana con un toque.", "Mantengan un enlace de sala fijo — se convierte en 'su lugar'.", "Dejen notas en el muro de recuerdos entre cita y cita."] }, C.es.what],
        faq: [C.es.private, C.es.free, C.es.app] },
      fr: { slug: "soiree-film-a-distance", title: "Soirée film à distance — un rendez-vous ciné pour couples à distance | SameCouch",
        desc: "Une vraie soirée ciné avec votre partenaire à distance : vidéo synchronisée, vos visages sur le film, réactions en emoji et un mur de souvenirs partagé. Gratuit.",
        kicker: "Pour les couples à distance", h1: "Soirée ciné avec votre amour à distance",
        intro: ["Le plus dur dans une relation à distance, ce ne sont pas les grandes choses — ce sont les soirées ordinaires que vous ne partagez pas. La soirée ciné est la plus facile à reprendre.",
          "Ouvrez votre salon, lancez la lecture ensemble et regardez-vous rire dans le coin de l'écran. Ensuite, laissez un mot ou une photo sur votre mur — il sera toujours là au prochain rendez-vous."],
        sections: [{ h2: "Faites-en un rituel", bullets: ["Planifiez votre soirée ciné et vous recevrez tous les deux un rappel.", "Après le film, programmez la même heure la semaine suivante en un geste.", "Gardez un lien de salon fixe — il devient « votre endroit ».", "Laissez des mots sur le mur de souvenirs entre deux rendez-vous."] }, C.fr.what],
        faq: [C.fr.private, C.fr.free, C.fr.app] },
      pt: { slug: "noite-de-cinema-a-distancia", title: "Noite de cinema a distância — encontro para casais a distância | SameCouch",
        desc: "Uma noite de cinema de verdade com seu amor a distância: vídeo sincronizado, seus rostos sobre o filme, reações com emojis e um mural de lembranças compartilhado. Grátis.",
        kicker: "Para casais a distância", h1: "Noite de cinema com seu amor a distância",
        intro: ["O mais difícil de um relacionamento a distância não são as grandes coisas — são as noites comuns que vocês não compartilham. A noite de cinema é a mais fácil de recuperar.",
          "Abram a sala, deem play juntos e vejam um ao outro rindo no canto da tela. Depois, deixem um recado ou uma foto no mural — vai continuar lá no próximo encontro."],
        sections: [{ h2: "Transformem isso num ritual", bullets: ["Agendem a noite de cinema e os dois recebem um lembrete.", "Depois do filme, agendem o mesmo horário na semana seguinte com um toque.", "Mantenham um link de sala fixo — ele vira 'o lugar de vocês'.", "Deixem recados no mural de lembranças entre um encontro e outro."] }, C.pt.what],
        faq: [C.pt.private, C.pt.free, C.pt.app] }
    },
    "watch-videos-with-family-abroad": {
      nl: { slug: "samen-kijken-met-familie-in-het-buitenland", title: "Samen kijken met familie in het buitenland — één kamer, één avond",
        desc: "Wees erbij op de avond thuis: kijk samen video's met je familie in het buitenland, zie iedereen live en deel foto's van de kinderen op een muur die blijft.",
        kicker: "Voor families op afstand", h1: "Breng de avond door met je familie thuis",
        intro: ["Miljoenen mensen werken ver van hun familie — en videobellen is altijd te snel voorbij, omdat er niets is om samen te doen.",
          "Een gedeelde huiskamer verandert dat: zet een video op waar iedereen van geniet, laat het gesprek rustig lopen en zit gewoon een avond in dezelfde (virtuele) kamer. Deel foto's van de kinderen op jullie muur; volgende week staan ze er nog."],
        sections: [{ h2: "Gemaakt voor de afstand", bullets: ["Tot 8 mensen — ouders, kinderen en grootouders in één kamer.", "Werkt op elke telefoon in de browser; niemand hoeft een app te installeren.", "18 talen, waaronder Arabisch, Hindi, Urdu, Tagalog, Bengaals en Tamil.", "De herinneringenmuur bewaart foto's en berichtjes tussen de bezoeken.", "De host kan een wachtwoord instellen, zodat het alleen voor familie blijft."] }, C.nl.what],
        faq: [C.nl.people, C.nl.app, C.nl.free] },
      de: { slug: "videos-mit-familie-im-ausland-schauen", title: "Videos mit der Familie im Ausland schauen — ein Raum, ein Abend",
        desc: "Sei beim Abend zu Hause dabei: schaue Videos mit deiner Familie im Ausland synchron, sieh alle live und teile Fotos der Kinder an einer Wand, die bleibt.",
        kicker: "Für Familien auf Distanz", h1: "Verbringe den Abend mit deiner Familie zu Hause",
        intro: ["Millionen Menschen arbeiten weit weg von ihrer Familie — und Videoanrufe sind immer zu schnell vorbei, weil es nichts gibt, was man gemeinsam tun kann.",
          "Ein gemeinsames Wohnzimmer ändert das: Macht ein Video an, das allen gefällt, lasst das Gespräch in Ruhe laufen und seid einfach einen Abend im selben (virtuellen) Raum. Teilt Fotos der Kinder an eurer Wand — nächste Woche sind sie noch da."],
        sections: [{ h2: "Gemacht für die Entfernung", bullets: ["Bis zu 8 Personen — Eltern, Kinder und Großeltern in einem Raum.", "Läuft auf jedem Handy im Browser; niemand muss eine App installieren.", "18 Sprachen, darunter Arabisch, Hindi, Urdu, Tagalog, Bengalisch und Tamil.", "Die Erinnerungswand bewahrt Fotos und Notizen zwischen den Besuchen.", "Der Host kann ein Raumpasswort setzen, damit es nur für die Familie bleibt."] }, C.de.what],
        faq: [C.de.people, C.de.app, C.de.free] },
      es: { slug: "ver-videos-con-familia-en-el-extranjero", title: "Ver vídeos con tu familia en el extranjero — una sala, una noche",
        desc: "Forma parte de la noche en casa: mira vídeos sincronizados con tu familia en el extranjero, ve a todos en directo y comparte fotos de los niños en un muro que permanece.",
        kicker: "Para familias a distancia", h1: "Pasa la noche con tu familia en casa",
        intro: ["Millones de personas trabajan lejos de su familia — y las videollamadas siempre se acaban demasiado pronto porque no hay nada que hacer juntos.",
          "Una sala de estar compartida lo cambia: pongan un vídeo que guste a todos, dejen que la conversación fluya y simplemente estén en la misma sala (virtual) toda una noche. Compartan fotos de los niños en su muro; la semana que viene seguirán ahí."],
        sections: [{ h2: "Hecho para la distancia", bullets: ["Hasta 8 personas — padres, hijos y abuelos en una sala.", "Funciona en el navegador de cualquier móvil; nadie tiene que instalar una app.", "18 idiomas, entre ellos árabe, hindi, urdu, tagalo, bengalí y tamil.", "El muro de recuerdos guarda fotos y notas entre visitas.", "El anfitrión puede poner una contraseña para que sea solo para la familia."] }, C.es.what],
        faq: [C.es.people, C.es.app, C.es.free] },
      fr: { slug: "regarder-des-videos-avec-sa-famille-a-l-etranger", title: "Regarder des vidéos avec sa famille à l'étranger — un salon, une soirée",
        desc: "Participez à la soirée à la maison : regardez des vidéos synchronisées avec votre famille à l'étranger, voyez tout le monde en direct et partagez les photos des enfants sur un mur qui reste.",
        kicker: "Pour les familles à distance", h1: "Passez la soirée avec votre famille restée au pays",
        intro: ["Des millions de personnes travaillent loin de leur famille — et les appels vidéo se terminent toujours trop vite, faute de quelque chose à faire ensemble.",
          "Un salon partagé change tout : lancez une vidéo qui plaît à tous, laissez la conversation respirer et soyez simplement dans la même pièce (virtuelle) le temps d'une soirée. Partagez les photos des enfants sur votre mur ; elles y seront encore la semaine prochaine."],
        sections: [{ h2: "Pensé pour la distance", bullets: ["Jusqu'à 8 personnes — parents, enfants et grands-parents dans un même salon.", "Fonctionne dans le navigateur de n'importe quel téléphone ; personne n'a d'appli à installer.", "18 langues, dont l'arabe, l'hindi, l'ourdou, le tagalog, le bengali et le tamoul.", "Le mur de souvenirs garde les photos et les mots entre deux visites.", "L'hôte peut définir un mot de passe pour que le salon reste familial."] }, C.fr.what],
        faq: [C.fr.people, C.fr.app, C.fr.free] },
      pt: { slug: "assistir-videos-com-a-familia-no-exterior", title: "Assistir vídeos com a família no exterior — uma sala, uma noite",
        desc: "Participe da noite em casa: assista vídeos sincronizados com sua família no exterior, veja todo mundo ao vivo e compartilhe fotos das crianças num mural que fica.",
        kicker: "Para famílias a distância", h1: "Passe a noite com sua família em casa",
        intro: ["Milhões de pessoas trabalham longe da família — e as chamadas de vídeo sempre acabam rápido demais porque não há nada para fazer juntos.",
          "Uma sala de estar compartilhada muda isso: coloquem um vídeo de que todos gostem, deixem a conversa fluir e fiquem simplesmente na mesma sala (virtual) por uma noite. Compartilhem fotos das crianças no mural; na semana que vem elas ainda estarão lá."],
        sections: [{ h2: "Feito para a distância", bullets: ["Até 8 pessoas — pais, filhos e avós numa só sala.", "Funciona no navegador de qualquer celular; ninguém precisa instalar app.", "18 idiomas, incluindo árabe, hindi, urdu, tagalo, bengali e tâmil.", "O mural de lembranças guarda fotos e recados entre as visitas.", "O anfitrião pode definir uma senha para a sala ficar só para a família."] }, C.pt.what],
        faq: [C.pt.people, C.pt.app, C.pt.free] }
    },
    "watch-movies-with-friends-online": {
      nl: { slug: "online-film-kijken-met-vrienden", title: "Online film kijken met vrienden — gratis privékamers",
        desc: "Breng filmavond terug met vrienden die zijn verhuisd: video perfect gelijk, webcams over de film, emoji-reacties en clips. Gratis, in de browser.",
        kicker: "Filmavond is terug", h1: "Film kijken met vrienden, waar ze ook wonen",
        intro: ["Vrienden waaieren uit — naar andere steden, andere landen. De groepsapp overleeft het, filmavond meestal niet.",
          "Een privékamer brengt hem terug: dezelfde film, op hetzelfde moment, ieders reacties in beeld, en het commentaar dat filmavond juist leuk maakte."],
        sections: [{ h2: "Gemaakt voor vriendengroepen", bullets: ["Tot 8 vrienden in één kamer, vanaf elk apparaat.", "Emoji-reacties regenen over het scherm; clips leggen de beste lachbuien vast.", "Het geluid van de film gaat automatisch zachter als iemand praat — geen 'WACHT, wat zei je?' meer.", "Eén vaste kamerlink: zet hem bij je favorieten en het is jullie filmavond-hoofdkwartier."] }, C.nl.what],
        faq: [C.nl.people, C.nl.free, C.nl.app] },
      de: { slug: "filme-mit-freunden-online-schauen", title: "Filme mit Freunden online schauen — kostenlose private Räume",
        desc: "Hol den Filmabend mit Freunden zurück, die weggezogen sind: synchrone Wiedergabe, Webcams über dem Film, Emoji-Reaktionen und Clips. Kostenlos, im Browser.",
        kicker: "Der Filmabend ist zurück", h1: "Filme mit Freunden schauen, egal wohin sie gezogen sind",
        intro: ["Freunde verstreuen sich — in andere Städte, andere Länder. Der Gruppenchat überlebt, der Filmabend meistens nicht.",
          "Ein privater Raum holt ihn zurück: derselbe Film, im selben Moment, die Reaktionen aller auf dem Bildschirm — und die Kommentare, die den Filmabend erst lustig gemacht haben."],
        sections: [{ h2: "Gemacht für Freundesgruppen", bullets: ["Bis zu 8 Freunde in einem Raum, von jedem Gerät.", "Emoji-Reaktionen regnen über den Bildschirm; Clips halten die besten Lacher fest.", "Der Film wird automatisch leiser, wenn jemand spricht — kein 'Warte, was hast du gesagt?' mehr.", "Ein fester Raum-Link: als Lesezeichen speichern, und ihr habt euer Filmabend-Hauptquartier."] }, C.de.what],
        faq: [C.de.people, C.de.free, C.de.app] },
      es: { slug: "ver-peliculas-con-amigos-online", title: "Ver películas con amigos online — salas privadas gratis",
        desc: "Recupera la noche de cine con los amigos que se mudaron: reproducción sincronizada, webcams sobre la película, reacciones con emojis y clips. Gratis, en el navegador.",
        kicker: "Vuelve la noche de cine", h1: "Ver películas con amigos, vivan donde vivan",
        intro: ["Los amigos se dispersan — a otras ciudades, a otros países. El grupo de chat sobrevive; la noche de cine, normalmente no.",
          "Una sala privada la recupera: la misma película, en el mismo momento, las reacciones de todos en pantalla y los comentarios que hacían divertida la noche de cine."],
        sections: [{ h2: "Hecho para grupos de amigos", bullets: ["Hasta 8 amigos en una sala, desde cualquier dispositivo.", "Las reacciones con emojis llueven sobre la pantalla; los clips capturan las mejores risas.", "La película baja de volumen sola cuando alguien habla — se acabó el '¿ESPERA, qué dijiste?'.", "Un enlace de sala fijo: guárdalo en favoritos y será su cuartel general de cine."] }, C.es.what],
        faq: [C.es.people, C.es.free, C.es.app] },
      fr: { slug: "regarder-des-films-entre-amis-en-ligne", title: "Regarder des films entre amis en ligne — salons privés gratuits",
        desc: "Retrouvez la soirée ciné avec les amis partis vivre ailleurs : lecture synchronisée, webcams sur le film, réactions en emoji et clips. Gratuit, dans le navigateur.",
        kicker: "La soirée ciné est de retour", h1: "Regarder des films entre amis, où qu'ils soient partis",
        intro: ["Les amis s'éparpillent — dans d'autres villes, d'autres pays. Le groupe de discussion survit ; la soirée ciné, rarement.",
          "Un salon privé la fait revivre : le même film, au même moment, les réactions de chacun à l'écran et les commentaires qui faisaient tout le sel de la soirée ciné."],
        sections: [{ h2: "Pensé pour les groupes d'amis", bullets: ["Jusqu'à 8 amis dans un salon, depuis n'importe quel appareil.", "Les réactions en emoji pleuvent sur l'écran ; les clips capturent les meilleurs fous rires.", "Le son du film baisse tout seul quand quelqu'un parle — fini les « ATTENDS, tu as dit quoi ? ».", "Un lien de salon fixe : ajoutez-le à vos favoris, c'est votre QG de la soirée ciné."] }, C.fr.what],
        faq: [C.fr.people, C.fr.free, C.fr.app] },
      pt: { slug: "assistir-filmes-com-amigos-online", title: "Assistir filmes com amigos online — salas privadas grátis",
        desc: "Traga de volta a noite de cinema com os amigos que se mudaram: reprodução sincronizada, webcams sobre o filme, reações com emojis e clipes. Grátis, no navegador.",
        kicker: "A noite de cinema voltou", h1: "Assistir filmes com amigos, onde quer que eles morem",
        intro: ["Os amigos se espalham — para outras cidades, outros países. O grupo do chat sobrevive; a noite de cinema, quase nunca.",
          "Uma sala privada traz ela de volta: o mesmo filme, no mesmo momento, a reação de todo mundo na tela e os comentários que deixavam a noite de cinema divertida."],
        sections: [{ h2: "Feito para grupos de amigos", bullets: ["Até 8 amigos numa sala, de qualquer aparelho.", "Reações com emojis chovem sobre a tela; clipes guardam as melhores risadas.", "O som do filme abaixa sozinho quando alguém fala — chega de 'PERA, o que você disse?'.", "Um link de sala fixo: salve nos favoritos e vira o QG da noite de cinema."] }, C.pt.what],
        faq: [C.pt.people, C.pt.free, C.pt.app] }
    }
  };
}

module.exports = { LOCALES, TRANSLATED: pages() };
