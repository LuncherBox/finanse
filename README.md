# Moje wydatki

Minimalistyczna aplikacja webowa do prywatnego śledzenia wydatków.

## Funkcje

- dostęp przez PIN weryfikowany po stronie serwera
- kategorie i podkategorie tworzone przez użytkownika
- dodawanie, edycja i usuwanie wydatków
- bieżąca suma miesięczna
- podsumowanie miesięczne według kategorii i udziału procentowego
- przechodzenie między miesiącami
- PostgreSQL
- eksport danych do JSON
- mobile-first i możliwość dodania strony do ekranu głównego telefonu

## Railway

Aplikacja wymaga dwóch zmiennych środowiskowych:

- `DATABASE_URL` - połączenie do PostgreSQL
- `APP_PIN` - prywatny PIN do aplikacji

Railway automatycznie ustawia `PORT`.

### Start

```
npm install
npm start
```

Przy uruchomieniu aplikacja sama tworzy wymagane tabele w PostgreSQL.
