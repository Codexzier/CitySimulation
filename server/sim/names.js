// Namen, Berufe und Texte für die Einwohner.
export const VORNAMEN_W = [
  'Anna', 'Lena', 'Marie', 'Sophie', 'Emma', 'Mia', 'Hannah', 'Lea', 'Laura', 'Julia', 'Sarah', 'Lisa',
  'Katharina', 'Johanna', 'Clara', 'Paula', 'Greta', 'Ida', 'Frieda', 'Nele', 'Mila', 'Ella', 'Charlotte',
  'Helene', 'Martha', 'Ingrid', 'Ursula', 'Monika', 'Sabine', 'Petra', 'Birgit', 'Anja', 'Jana', 'Svenja',
  'Leonie', 'Amelie', 'Romy', 'Luisa', 'Selin', 'Aylin',
];

export const VORNAMEN_M = [
  'Lukas', 'Jonas', 'Leon', 'Felix', 'Paul', 'Max', 'Ben', 'Elias', 'Noah', 'Finn', 'Tim', 'Jan', 'Moritz',
  'Niklas', 'Tobias', 'David', 'Simon', 'Florian', 'Matthias', 'Stefan', 'Thomas', 'Michael', 'Andreas',
  'Jürgen', 'Klaus', 'Peter', 'Uwe', 'Dieter', 'Henrik', 'Ole', 'Emil', 'Anton', 'Karl', 'Theo', 'Mats',
  'Malte', 'Johannes', 'Can', 'Milan', 'Luca',
];

export const NACHNAMEN = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
  'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann',
  'Braun', 'Krüger', 'Hofmann', 'Hartmann', 'Lange', 'Schmitt', 'Werner', 'Schmitz', 'Krause', 'Meier',
  'Lehmann', 'Köhler', 'Herrmann', 'König', 'Walter', 'Mayer', 'Huber', 'Kaiser', 'Fuchs', 'Peters',
  'Lang', 'Scholz', 'Möller', 'Weiß', 'Jung', 'Hahn', 'Vogel', 'Friedrich', 'Keller', 'Günther', 'Yilmaz',
];

// Branchen je Industrieviertel (Viertel-ID → Branchen)
export const BRANCHEN_JE_VIERTEL = {
  1: ['Metall', 'Maschinenbau'],
  3: ['Chemie', 'Energie'],
  5: ['Logistik', 'Lebensmittel'],
};

export const BERUFE = {
  Metall: [['Schweißer', 'Schweißerin'], ['Schlosser', 'Schlosserin'], ['Gießer', 'Gießerin'],
    ['Industriemechaniker', 'Industriemechanikerin']],
  Maschinenbau: [['Ingenieur', 'Ingenieurin'], ['Mechatroniker', 'Mechatronikerin'],
    ['Zerspanungsmechaniker', 'Zerspanungsmechanikerin'], ['Konstrukteur', 'Konstrukteurin']],
  Chemie: [['Chemikant', 'Chemikantin'], ['Laborant', 'Laborantin'], ['Pharmakant', 'Pharmakantin'],
    ['Chemiker', 'Chemikerin']],
  Energie: [['Anlagenführer', 'Anlagenführerin'], ['Elektroniker', 'Elektronikerin'],
    ['Energietechniker', 'Energietechnikerin']],
  Logistik: [['Lagerist', 'Lageristin'], ['Staplerfahrer', 'Staplerfahrerin'], ['Disponent', 'Disponentin'],
    ['Berufskraftfahrer', 'Berufskraftfahrerin']],
  Lebensmittel: [['Bäcker', 'Bäckerin'], ['Lebensmitteltechniker', 'Lebensmitteltechnikerin'],
    ['Brauer', 'Brauerin'], ['Koch', 'Köchin']],
};

export const BETRIEBSNAMEN = {
  Metall: ['Stahlwerk', 'Gießerei', 'Metallbau', 'Walzwerk'],
  Maschinenbau: ['Maschinenfabrik', 'Werkzeugbau', 'Getriebewerk'],
  Chemie: ['Chemiewerk', 'Pharmalabor', 'Farbenfabrik'],
  Energie: ['Kraftwerk', 'Stadtwerke', 'Solarfabrik'],
  Logistik: ['Logistikzentrum', 'Speditionslager', 'Paketzentrum'],
  Lebensmittel: ['Großbäckerei', 'Brauerei', 'Konservenfabrik'],
};

// Gedanken/Emotionen → Emote-Symbol aus dem Kenney-Paket
export const EMOTES = {
  verliebt: { sym: 'hearts', text: 'Verliebt' },
  liebeskummer: { sym: 'heartBroken', text: 'Liebeskummer' },
  enttaeuscht: { sym: 'faceSad', text: 'Enttäuscht' },
  singen: { sym: 'music', text: 'Singt' },
  freuen: { sym: 'faceHappy', text: 'Freut sich' },
  boese: { sym: 'anger', text: 'Böse' },
  schlafend: { sym: 'sleeps', text: 'Schläft' },
  schwitzend: { sym: 'drops', text: 'Schwitzt' },
  sorglos: { sym: 'cash', text: 'Sorglos' },
  entsetzt: { sym: 'exclamations', text: 'Entsetzt' },
  fragend: { sym: 'question', text: 'Fragend' },
  abweisend: { sym: 'cross', text: 'Abweisend' },
  benommen: { sym: 'swirl', text: 'Benommen' },
};
