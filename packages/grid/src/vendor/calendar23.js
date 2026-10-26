/**
 * @summary     Calendar23
 * @description calendar on pure javascript
 * @version     1.0.3
 * @file        calendar23
 * @author      realmag777
 * @contact     https://realmag777.com
 * @github      https://github.com/realmag777/calendar23
 * @copyright   Copyright 2020-2025 Rostislav Sofronov <realmag777>
 *
 * This source file is free software, available under the following license:
 * MIT license - https://en.wikipedia.org/wiki/MIT_License .Basically that
 * means you are free to use Calendar23 as long as this header is left intact.
 */

'use strict';
//12-03-2025
// Copied into LYNX Grid from the Botoscope plugin (assets/js/lib/calendar23.js, v1.0.3) on
// 2026-10-01. Two fixes, marked 'LYNX fix': zero-padding of 10 o'clock and 10 minutes in the
// time input, and save() without show_time (hours were undefined, giving an invalid date).
export default class Calendar23 {

    constructor(container, scene = 2, calendar_id = null, unix_time_stamp = null, additional = {}) {
        this.scene = scene;//0,1,2

        this.month_names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        this.month_names_short = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        this.day_names = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
        this.show_time = false;

        if (typeof additional.calendar_names !== 'undefined') {
            if (typeof additional.calendar_names.month_names !== 'undefined') {
                this.month_names = additional.calendar_names.month_names;
            }

            if (typeof additional.calendar_names.month_names_short !== 'undefined') {
                this.month_names_short = additional.calendar_names.month_names_short;
            }

            if (typeof additional.calendar_names.day_names !== 'undefined') {
                this.day_names = additional.calendar_names.day_names;
            }
        }

        //***

        if (typeof additional.month_names !== 'undefined') {
            this.month_names = additional.month_names;
        }

        if (typeof additional.month_names_short !== 'undefined') {
            this.month_names_short = additional.month_names_short;
        }

        if (typeof additional.day_names !== 'undefined') {
            this.day_names = additional.day_names;
        }

        if (typeof additional.show_time !== 'undefined') {
            this.show_time = additional.show_time;
            this.selected_hour = 0;
            this.selected_minute = 0;
        }

        //***
        this.calendar_id = calendar_id;

        if (!this.calendar_id) {
            this.calendar_id = this.create_id('calendar-');
        }

        //***

        if (!unix_time_stamp) {
            this.current_date = new Date();
        } else {
            this.current_date = new Date(Date.UTC(
                    new Date(unix_time_stamp * 1000).getUTCFullYear(),
                    new Date(unix_time_stamp * 1000).getUTCMonth(),
                    new Date(unix_time_stamp * 1000).getUTCDate(),
                    new Date(unix_time_stamp * 1000).getUTCHours(),
                    new Date(unix_time_stamp * 1000).getUTCMinutes(),
                    new Date(unix_time_stamp * 1000).getUTCSeconds()
                    ));
            if (this.show_time) {
                this.selected_hour = this.get_hours();
                this.selected_minute = this.get_minutes();
            }
        }

        this.today = new Date();
        this.current_date.setUTCHours(0, 0, 0, 0);
        this.selected_date = new Date(this.current_date.getTime());//selected by click
        this.selected_date.setUTCHours(0, 0, 0, 0);

        this.container = container;
        this.cells = [];
        this.fill_container();
    }

    fill_container() {
        this.cells = [];
        this.container.innerHTML = '';

        //***

        switch (this.scene) {
            case 0:
                this.fill_scene_0();//days
                break;

            case 1:
                this.fill_scene_1();//years
                break;

            case 2:
                this.fill_scene_2();//monthes
                break;

            default:
                this.fill_scene();//for extended classes
                break;
        }
    }

    fill_scene() {
        //must be reload
    }

    get_prev_month_days_count() {
        let m = this.get_month() - 1;
        let y = this.get_year();
        if (m < 0) {
            m = 11;
            y--;
        }

        return new Date(y, m + 1, 0).getDate();

    }

    get_month() {
        return this.current_date.getMonth();
    }

    get_year() {
        return this.current_date.getFullYear();
    }

    get_hours() {
        return this.current_date.getUTCHours();
    }

    get_minutes() {
        return this.current_date.getUTCMinutes();
    }

    get_days_in_month() {
        return new Date(this.get_year(), this.get_month() + 1, 0).getDate();
    }

    //***

    create_label_0() {
        let label = document.createElement('div');
        label.className = 'calendar23-label';

        let span = document.createElement('span');
        span.innerText = this.month_names[this.get_month()] + ' ' + this.get_year();
        label.appendChild(span);

        span.addEventListener('click', e => {
            e.stopPropagation();
            this.scene = 1;
            /*
             * 0 - days calendar
             * 1 - monthes list 7x5
             * 2 - years list 7x5
             */

            this.fill_container();
            return false;
        });

        //***

        let prev = document.createElement('a');
        prev.setAttribute('href', '#');
        prev.className = 'calendar23-prev';
        prev.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            let m = this.get_month() - 1;
            let y = this.get_year();
            if (m < 0) {
                m = 11;
                y--;
            }

            this.current_date = new Date(y, m, 1);
            this.fill_container();
            return false;
        });

        label.appendChild(prev);


        //***

        let next = document.createElement('a');
        next.setAttribute('href', '#');
        next.className = 'calendar23-next';
        next.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            let m = this.get_month() + 1;
            let y = this.get_year();
            if (m > 11) {
                m = 0;
                y++;
            }

            this.current_date = new Date(y, m, 1);
            this.fill_container();
            return false;
        });

        label.appendChild(next);

        //***

        return label;
    }

    fill_scene_0() {
        let month = document.createElement('div');
        month.className = 'calendar23-month';
        month.appendChild(this.create_label_0());

        for (let i = 0; i < 7; ++i) {
            let d = document.createElement('div');
            d.className = 'calendar23-dow';
            d.innerText = this.day_names[i];
            month.appendChild(d);
        }

        //***

        for (let i = 0; i < 42; ++i) {//7x6
            this.cells[i] = document.createElement('div');
            month.appendChild(this.cells[i]);
        }

        this.container.appendChild(month);

        //***

        let first_month_day = new Date(this.get_year(), this.get_month(), 1).getDay() - 1;//TODO when sunday first
        if (first_month_day < 0) {
            first_month_day = 6;
        }

        let day = 1;
        for (let i = first_month_day; i < this.get_days_in_month() + first_month_day; ++i) {
            let c = new Date(Date.UTC(this.get_year(), this.get_month(), day, 0, 0, 0, 0));
            c.setUTCHours(0, 0, 0, 0);
            this.cells[i].innerText = day;
            this.cells[i].className = 'calendar23-day';
            this.cells[i].setAttribute('data-date', c.getTime() / 1000);

            if ([0, 6].includes(new Date(this.get_year(), this.get_month(), day).getDay())) {
                this.cells[i].classList.add('calendar23-weekend');
            }

            if (this.today.getDate() === day && this.today.getMonth() === this.get_month() && this.today.getFullYear() === this.get_year()) {
                this.cells[i].classList.add('calendar23-today');
            }

            if (this.selected_date !== null) {
                if (this.selected_date.getDate() === day && this.selected_date.getMonth() === this.get_month() && this.selected_date.getFullYear() === this.get_year()) {
                    this.cells[i].classList.add('calendar23-focused');
                }
            }

            day++;

            //***
            this.cells[i].addEventListener('click', e => {
                e.stopPropagation();
                this.focus(this.cells[i]);
                return false;
            });

            this.rich_cell_content(this.cells[i]);
        }


        //***
        //prev month days fill
        for (let i = 0; i < first_month_day; ++i) {
            this.cells[i].className = 'calendar23-dummy-day';
            this.cells[i].innerText = this.get_prev_month_days_count() - first_month_day + i + 1;
        }

        //***
        //next month days fill
        let next_month_day = 1;
        for (let i = 0; i < 42; ++i) {
            if (this.cells[i].innerText.length === 0) {
                this.cells[i].className = 'calendar23-dummy-day';
                this.cells[i].innerText = next_month_day++;
            }
        }

        //remove last not this month week
        let clear = true;
        for (let i = 42 - 7; i < 42; i++) {
            if (!this.cells[i].classList.contains('calendar23-dummy-day')) {
                clear = false;
                break;
            }
        }

        if (clear) {
            for (let i = 42 - 7; i < 42; i++) {
                this.cells[i].remove();
            }
        }

        //+++
        if (this.show_time) {
            let time = document.createElement('div');
            time.className = 'calendar23-time';
            this.container.appendChild(time);

            let input = document.createElement('input');
            input.setAttribute('type', 'time');
            input.setAttribute('min', '00:00');
            input.setAttribute('max', '23:59');
            input.className = 'calendar23-time';
            let hh = this.selected_hour >= 10 ? this.selected_hour : `0${this.selected_hour}`;//LYNX fix: was > 10
            let mm = this.selected_minute >= 10 ? this.selected_minute : `0${this.selected_minute}`;//LYNX fix: was > 10
            input.value = `${hh}:${mm}`;
            time.appendChild(input);

            time.addEventListener('change', e => {
                [this.selected_hour, this.selected_minute] = e.target.value.split(':').map(Number);

            });

            //lets add button in this case
            let save = document.createElement('a');
            save.setAttribute('href', '#');
            save.textContent = '✔️';
            save.className = 'calendar23-save button button-primary';
            this.container.appendChild(save);

            save.addEventListener('click', e => {
                e.preventDefault();
                this.save();
                return false;
            });
        }
    }

    rich_cell_content(cell) {
        //reload
    }

    //***

    focus(cell) {
        this.current_date = new Date(cell.getAttribute('data-date') * 1000);
        this.selected_date = new Date(cell.getAttribute('data-date') * 1000);
        this.selected_date.setUTCHours(0, 0, 0, 0);

        for (let y = 0; y < this.cells.length; y++) {
            if (this.cells[y].classList.contains('calendar23-focused')) {
                this.cells[y].classList.remove('calendar23-focused');
                break;
            }
        }

        cell.classList.add('calendar23-focused');
        //this.focused_cell=cell;
        this.select_date();

        return cell;
    }

    //***

    create_label_1() {
        let label = document.createElement('div');
        label.className = 'calendar23-label';

        let span = document.createElement('span');
        span.innerText = this.get_year();
        label.appendChild(span);

        span.addEventListener('click', e => {
            e.stopPropagation();
            this.scene = 2;
            this.fill_container();
            return false;
        });

        //***

        let prev = document.createElement('a');
        prev.setAttribute('href', '#');
        prev.className = 'calendar23-prev';
        prev.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            this.current_date = new Date(Date.UTC(this.get_year() - 1, this.get_month(), 1));
            this.fill_container();
            return false;
        });

        label.appendChild(prev);

        //***

        let next = document.createElement('a');
        next.setAttribute('href', '#');
        next.className = 'calendar23-next';
        next.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            this.current_date = new Date(this.get_year() + 1, this.get_month(), 1);
            this.fill_container();
            return false;
        });

        label.appendChild(next);

        //***

        return label;
    }

    fill_scene_1() {
        let monthes = document.createElement('div');
        monthes.className = 'calendar23-month';
        monthes.appendChild(this.create_label_1());

        for (let i = 0; i < 12; ++i) {
            this.cells[i] = document.createElement('div');
            this.cells[i].className = 'calendar23-big calendar23-day';
            this.cells[i].setAttribute('data-month', i);
            this.cells[i].innerText = this.month_names_short[i];
            if (this.today.getMonth() === i && this.today.getFullYear() === this.get_year()) {
                this.cells[i].classList.add('calendar23-today');
            }
            monthes.appendChild(this.cells[i]);

            //***
            let _this = this;
            this.cells[i].addEventListener('click', function (e) {
                e.stopPropagation();
                _this.current_date.setMonth(this.getAttribute('data-month'));
                _this.scene = 0;
                _this.fill_container();
                return false;
            });
        }

        this.container.appendChild(monthes);

    }

    //***

    create_label_2() {
        let label = document.createElement('div');
        label.className = 'calendar23-label';

        let span = document.createElement('span');
        span.innerText = this.get_year() + ' - ' + (this.get_year() + 12 - 1);
        label.appendChild(span);

        //***

        let prev = document.createElement('a');
        prev.setAttribute('href', '#');
        prev.className = 'calendar23-prev';
        prev.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            this.current_date = new Date(this.get_year() - 12, this.get_month(), 1);
            this.fill_container();
            return false;
        });

        label.appendChild(prev);


        //***

        let next = document.createElement('a');
        next.setAttribute('href', '#');
        next.className = 'calendar23-next';
        next.addEventListener('click', e => {
            e.stopPropagation();
            e.preventDefault();
            this.current_date = new Date(this.get_year() + 12, this.get_month(), 1);
            this.fill_container();
            return false;
        });

        label.appendChild(next);

        //***

        return label;
    }

    fill_scene_2() {
        let _this = this;
        let years = document.createElement('div');
        years.className = 'calendar23-month';
        years.appendChild(this.create_label_2());

        for (let i = this.get_year(); i < this.get_year() + 12; ++i) {
            this.cells[i] = document.createElement('div');
            this.cells[i].className = 'calendar23-big calendar23-day';
            this.cells[i].setAttribute('data-year', i);
            this.cells[i].innerText = i;
            if (this.today.getFullYear() === i) {
                this.cells[i].classList.add('calendar23-today');
            }
            years.appendChild(this.cells[i]);

            //***

            this.cells[i].addEventListener('click', function (e) {
                e.stopPropagation();
                _this.current_date.setFullYear(this.getAttribute('data-year'));
                _this.scene = 1;
                _this.fill_container();
                return false;
            });
        }

        this.container.appendChild(years);
    }

    create_id(prefix = '') {
        return prefix + Math.random().toString(36).substring(7);
    }

    select_date() {
        if (!this.show_time) {
            this.save();
        }
    }

    //api, can be overloaded
    save() {
        const date = new Date(this.selected_date);
        date.setUTCHours(this.selected_hour || 0, this.selected_minute || 0, 0, 0);//LYNX fix: no time part when show_time is off // Принудительно в UTC
        let unix_time_stamp = Math.floor(date.getTime() / 1000);

        if (!this.show_time) {
            document.dispatchEvent(new CustomEvent('calendar23-date-selected', {detail: {date: unix_time_stamp, calendar_id: this.calendar_id}}));
        } else {
            document.dispatchEvent(new CustomEvent('calendar23-date-selected', {detail: {date: unix_time_stamp, hour: this.selected_hour, minute: this.selected_minute, calendar_id: this.calendar_id}}));
        }
    }
}

