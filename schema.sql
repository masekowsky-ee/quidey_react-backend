-- Quidey database schema (structure only, no data)
--
-- Generated from the development database with:
--   pg_dump --schema-only --no-owner --no-privileges --no-comments
-- Cleaned up so it also runs outside psql and on PostgreSQL versions before 17.
--
-- Set up a fresh database (e.g. on the server):
--   createdb quidey
--   psql -d quidey -f schema.sql
--
-- After changing tables, regenerate this file the same way so it stays the source of truth.

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- *not* creating schema, since initdb creates it

--
-- Name: users_protect_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.users_protect_owner() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.is_owner IS DISTINCT FROM (CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.is_owner END)
        AND current_setting('is_superuser') <> 'on' THEN
        RAISE EXCEPTION 'is_owner can only be changed by hand as a database superuser';
    END IF;
    IF NEW.is_owner THEN
        NEW.is_admin := true;
    END IF;
    RETURN NEW;
END $$;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_actions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_actions (
    id integer NOT NULL,
    admin_id integer,
    admin_username text NOT NULL,
    target_id integer,
    target_username text NOT NULL,
    action text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'grant_tester'::text, 'revoke_tester'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text])))
);

--
-- Name: admin_actions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.admin_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: admin_actions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.admin_actions_id_seq OWNED BY public.admin_actions.id;

--
-- Name: beta_access_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beta_access_requests (
    user_id integer NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT beta_access_requests_reason_check CHECK (((length(reason) >= 10) AND (length(reason) <= 1000))),
    CONSTRAINT beta_access_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text])))
);

--
-- Name: broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.broadcasts (
    id integer NOT NULL,
    admin_id integer,
    admin_username text,
    title text NOT NULL,
    body text NOT NULL,
    recipient_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    audience text DEFAULT 'all'::text NOT NULL,
    CONSTRAINT broadcasts_audience_check CHECK ((audience = ANY (ARRAY['all'::text, 'testers'::text]))),
    CONSTRAINT broadcasts_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000))),
    CONSTRAINT broadcasts_title_check CHECK (((length(title) >= 1) AND (length(title) <= 120)))
);

--
-- Name: broadcasts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.broadcasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: broadcasts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.broadcasts_id_seq OWNED BY public.broadcasts.id;

--
-- Name: email_verification_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_verification_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.email_verification_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: email_verification_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.email_verification_tokens_id_seq OWNED BY public.email_verification_tokens.id;

--
-- Name: friendships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.friendships (
    id integer NOT NULL,
    requester_id integer NOT NULL,
    addressee_id integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT friendships_check CHECK ((requester_id <> addressee_id)),
    CONSTRAINT friendships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])))
);

--
-- Name: friendships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.friendships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: friendships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.friendships_id_seq OWNED BY public.friendships.id;

--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    user_id integer,
    color text,
    CONSTRAINT groups_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text]))))
);

--
-- Name: groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.groups_id_seq OWNED BY public.groups.id;

--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id integer NOT NULL,
    sender_id integer NOT NULL,
    recipient_id integer NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    CONSTRAINT messages_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000))),
    CONSTRAINT messages_check CHECK ((sender_id <> recipient_id))
);

--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;

--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id integer NOT NULL,
    task_id integer,
    content text,
    created_at timestamp without time zone DEFAULT now()
);

--
-- Name: notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notes_id_seq OWNED BY public.notes.id;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id integer NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    broadcast_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    data jsonb,
    CONSTRAINT notifications_body_check CHECK (((length(body) >= 1) AND (length(body) <= 2000))),
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['broadcast'::text, 'system'::text, 'task_assigned'::text]))),
    CONSTRAINT notifications_title_check CHECK (((length(title) >= 1) AND (length(title) <= 120)))
);

--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;

--
-- Name: session_shared_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_shared_tasks (
    session_id integer NOT NULL,
    shared_task_id integer NOT NULL,
    time_ms integer DEFAULT 0 NOT NULL,
    CONSTRAINT session_shared_tasks_time_ms_check CHECK ((time_ms >= 0))
);

--
-- Name: session_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_tasks (
    session_id integer NOT NULL,
    task_id integer NOT NULL,
    time_ms integer DEFAULT 0 NOT NULL
);

--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id integer NOT NULL,
    group_id integer,
    time_ms integer,
    date timestamp without time zone DEFAULT now(),
    user_id integer
);

--
-- Name: sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;

--
-- Name: shared_session_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_events (
    id integer NOT NULL,
    session_id integer NOT NULL,
    user_id integer,
    type text NOT NULL,
    task_id integer,
    task_name text,
    text text,
    target_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_session_events_text_check CHECK ((length(text) <= 1000)),
    CONSTRAINT shared_session_events_type_check CHECK ((type = ANY (ARRAY['created'::text, 'joined'::text, 'left'::text, 'removed'::text, 'task_added'::text, 'task_done'::text, 'task_reopened'::text, 'task_assigned'::text, 'started'::text, 'message'::text, 'renamed'::text, 'ended'::text])))
);

--
-- Name: shared_session_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_session_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_session_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_session_events_id_seq OWNED BY public.shared_session_events.id;

--
-- Name: shared_session_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_members (
    session_id integer NOT NULL,
    user_id integer NOT NULL,
    status text DEFAULT 'invited'::text NOT NULL,
    invited_by integer,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone,
    current_task_id integer,
    last_seen_at timestamp with time zone,
    CONSTRAINT shared_session_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'joined'::text])))
);

--
-- Name: shared_session_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_tasks (
    id integer NOT NULL,
    session_id integer NOT NULL,
    name text NOT NULL,
    description text,
    done boolean DEFAULT false NOT NULL,
    added_by integer,
    source_task_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assignee_id integer,
    due date,
    due_time time without time zone,
    prio integer,
    duration_minutes integer,
    location text,
    link text,
    details text,
    color text,
    CONSTRAINT shared_session_tasks_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT shared_session_tasks_due_time_needs_due_check CHECK (((due_time IS NULL) OR (due IS NOT NULL))),
    CONSTRAINT shared_session_tasks_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes >= 1) AND (duration_minutes <= 10080)))),
    CONSTRAINT shared_session_tasks_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)))
);

--
-- Name: shared_session_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_session_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_session_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_session_tasks_id_seq OWNED BY public.shared_session_tasks.id;

--
-- Name: shared_session_time; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_time (
    task_id integer NOT NULL,
    user_id integer NOT NULL,
    time_ms bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_session_time_time_ms_check CHECK ((time_ms >= 0))
);

--
-- Name: shared_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_sessions (
    id integer NOT NULL,
    name text NOT NULL,
    owner_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT shared_sessions_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100)))
);

--
-- Name: shared_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_sessions_id_seq OWNED BY public.shared_sessions.id;

--
-- Name: task_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_groups (
    task_id integer NOT NULL,
    group_id integer NOT NULL
);

--
-- Name: task_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_shares (
    id integer NOT NULL,
    task_id integer NOT NULL,
    user_id integer NOT NULL,
    invited_by integer,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    CONSTRAINT task_shares_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text])))
);

--
-- Name: task_shares_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.task_shares_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: task_shares_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.task_shares_id_seq OWNED BY public.task_shares.id;

--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id integer NOT NULL,
    name text NOT NULL,
    due date,
    description text,
    prio integer,
    done boolean DEFAULT false,
    created_at timestamp without time zone DEFAULT now(),
    user_id integer,
    due_time time without time zone,
    duration_minutes integer,
    reminder_minutes integer,
    location text,
    link text,
    details text,
    repeat text,
    repeat_from_id integer,
    completed_at timestamp with time zone,
    color text,
    reminder_email boolean DEFAULT false NOT NULL,
    reminder_mailed_at timestamp with time zone,
    CONSTRAINT tasks_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT tasks_due_time_needs_due_check CHECK (((due_time IS NULL) OR (due IS NOT NULL))),
    CONSTRAINT tasks_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes >= 1) AND (duration_minutes <= 10080)))),
    CONSTRAINT tasks_reminder_minutes_check CHECK (((reminder_minutes IS NULL) OR ((reminder_minutes >= 0) AND (reminder_minutes <= 10080)))),
    CONSTRAINT tasks_repeat_check CHECK (((repeat IS NULL) OR (repeat = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text])))),
    CONSTRAINT tasks_repeat_needs_due_check CHECK (((repeat IS NULL) OR (due IS NOT NULL)))
);

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;

--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id integer NOT NULL,
    username text NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    display_name text,
    birth_date date,
    email text NOT NULL,
    is_pro boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    token_version integer DEFAULT 0 NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    terms_accepted_at timestamp with time zone,
    privacy_accepted_at timestamp with time zone,
    is_owner boolean DEFAULT false NOT NULL,
    timezone text,
    language text,
    is_tester boolean DEFAULT false NOT NULL,
    bio text,
    status_text text,
    study text,
    interests text[] DEFAULT '{}'::text[] NOT NULL,
    profile_color text,
    banner text,
    avatar_emoji text,
    show_stats boolean DEFAULT true NOT NULL,
    CONSTRAINT users_avatar_emoji_check CHECK (((avatar_emoji IS NULL) OR (length(avatar_emoji) <= 16))),
    CONSTRAINT users_banner_check CHECK (((banner IS NULL) OR (banner = ANY (ARRAY['gradient'::text, 'aurora'::text, 'dots'::text, 'stripes'::text, 'grid'::text, 'glow'::text])))),
    CONSTRAINT users_bio_check CHECK (((bio IS NULL) OR (length(bio) <= 280))),
    CONSTRAINT users_interests_check CHECK ((cardinality(interests) <= 6)),
    CONSTRAINT users_language_check CHECK (((language IS NULL) OR (language = ANY (ARRAY['de'::text, 'en'::text])))),
    CONSTRAINT users_profile_color_check CHECK (((profile_color IS NULL) OR (profile_color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT users_status_text_check CHECK (((status_text IS NULL) OR (length(status_text) <= 80))),
    CONSTRAINT users_study_check CHECK (((study IS NULL) OR (length(study) <= 60)))
);

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

--
-- Name: admin_actions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions ALTER COLUMN id SET DEFAULT nextval('public.admin_actions_id_seq'::regclass);

--
-- Name: broadcasts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcasts ALTER COLUMN id SET DEFAULT nextval('public.broadcasts_id_seq'::regclass);

--
-- Name: email_verification_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens ALTER COLUMN id SET DEFAULT nextval('public.email_verification_tokens_id_seq'::regclass);

--
-- Name: friendships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships ALTER COLUMN id SET DEFAULT nextval('public.friendships_id_seq'::regclass);

--
-- Name: groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups ALTER COLUMN id SET DEFAULT nextval('public.groups_id_seq'::regclass);

--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);

--
-- Name: notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes ALTER COLUMN id SET DEFAULT nextval('public.notes_id_seq'::regclass);

--
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);

--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

--
-- Name: shared_session_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events ALTER COLUMN id SET DEFAULT nextval('public.shared_session_events_id_seq'::regclass);

--
-- Name: shared_session_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks ALTER COLUMN id SET DEFAULT nextval('public.shared_session_tasks_id_seq'::regclass);

--
-- Name: shared_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions ALTER COLUMN id SET DEFAULT nextval('public.shared_sessions_id_seq'::regclass);

--
-- Name: task_shares id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares ALTER COLUMN id SET DEFAULT nextval('public.task_shares_id_seq'::regclass);

--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);

--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

--
-- Name: admin_actions admin_actions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_pkey PRIMARY KEY (id);

--
-- Name: beta_access_requests beta_access_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_access_requests
    ADD CONSTRAINT beta_access_requests_pkey PRIMARY KEY (user_id);

--
-- Name: broadcasts broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcasts
    ADD CONSTRAINT broadcasts_pkey PRIMARY KEY (id);

--
-- Name: email_verification_tokens email_verification_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_pkey PRIMARY KEY (id);

--
-- Name: email_verification_tokens email_verification_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_token_hash_key UNIQUE (token_hash);

--
-- Name: friendships friendships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_pkey PRIMARY KEY (id);

--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);

--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);

--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);

--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

--
-- Name: session_shared_tasks session_shared_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_pkey PRIMARY KEY (session_id, shared_task_id);

--
-- Name: session_tasks session_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_pkey PRIMARY KEY (session_id, task_id);

--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

--
-- Name: shared_session_events shared_session_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_pkey PRIMARY KEY (id);

--
-- Name: shared_session_members shared_session_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_pkey PRIMARY KEY (session_id, user_id);

--
-- Name: shared_session_tasks shared_session_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_pkey PRIMARY KEY (id);

--
-- Name: shared_session_time shared_session_time_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_pkey PRIMARY KEY (task_id, user_id);

--
-- Name: shared_sessions shared_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions
    ADD CONSTRAINT shared_sessions_pkey PRIMARY KEY (id);

--
-- Name: task_groups task_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_pkey PRIMARY KEY (task_id, group_id);

--
-- Name: task_shares task_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_pkey PRIMARY KEY (id);

--
-- Name: task_shares task_shares_task_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_task_id_user_id_key UNIQUE (task_id, user_id);

--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

--
-- Name: users users_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_username_key UNIQUE (username);

--
-- Name: admin_actions_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_actions_created_idx ON public.admin_actions USING btree (created_at DESC);

--
-- Name: beta_access_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX beta_access_requests_status_idx ON public.beta_access_requests USING btree (status, created_at);

--
-- Name: email_verification_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_verification_tokens_user_idx ON public.email_verification_tokens USING btree (user_id);

--
-- Name: friendships_addressee_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_addressee_status_idx ON public.friendships USING btree (addressee_id, status);

--
-- Name: friendships_pair_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX friendships_pair_unique ON public.friendships USING btree (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

--
-- Name: friendships_requester_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX friendships_requester_status_idx ON public.friendships USING btree (requester_id, status);

--
-- Name: groups_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX groups_user_idx ON public.groups USING btree (user_id);

--
-- Name: messages_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_recipient_idx ON public.messages USING btree (recipient_id, created_at);

--
-- Name: messages_sender_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_sender_idx ON public.messages USING btree (sender_id, created_at);

--
-- Name: messages_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_unread_idx ON public.messages USING btree (recipient_id, sender_id) WHERE (read_at IS NULL);

--
-- Name: notes_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notes_task_idx ON public.notes USING btree (task_id);

--
-- Name: notifications_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);

--
-- Name: notifications_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_idx ON public.notifications USING btree (user_id, created_at);

--
-- Name: session_tasks_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_tasks_task_idx ON public.session_tasks USING btree (task_id);

--
-- Name: sessions_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_group_idx ON public.sessions USING btree (group_id);

--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);

--
-- Name: shared_session_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_events_session_idx ON public.shared_session_events USING btree (session_id, id);

--
-- Name: shared_session_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_members_user_idx ON public.shared_session_members USING btree (user_id, status);

--
-- Name: shared_session_tasks_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_tasks_session_idx ON public.shared_session_tasks USING btree (session_id);

--
-- Name: shared_session_tasks_source_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX shared_session_tasks_source_unique ON public.shared_session_tasks USING btree (session_id, source_task_id) WHERE (source_task_id IS NOT NULL);

--
-- Name: shared_session_time_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_time_user_idx ON public.shared_session_time USING btree (user_id);

--
-- Name: shared_sessions_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_sessions_owner_idx ON public.shared_sessions USING btree (owner_id);

--
-- Name: task_groups_group_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_groups_group_idx ON public.task_groups USING btree (group_id);

--
-- Name: task_shares_user_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX task_shares_user_status_idx ON public.task_shares USING btree (user_id, status);

--
-- Name: tasks_reminder_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_reminder_email_idx ON public.tasks USING btree (due) WHERE (reminder_email AND (NOT done));

--
-- Name: tasks_repeat_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_repeat_from_idx ON public.tasks USING btree (repeat_from_id);

--
-- Name: tasks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_user_idx ON public.tasks USING btree (user_id);

--
-- Name: users_email_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower(email));

--
-- Name: users_username_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_lower_unique ON public.users USING btree (lower(username));

--
-- Name: users users_protect_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_protect_owner BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.users_protect_owner();

--
-- Name: admin_actions admin_actions_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: admin_actions admin_actions_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_actions
    ADD CONSTRAINT admin_actions_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: beta_access_requests beta_access_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beta_access_requests
    ADD CONSTRAINT beta_access_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: broadcasts broadcasts_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.broadcasts
    ADD CONSTRAINT broadcasts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: friendships friendships_addressee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_addressee_id_fkey FOREIGN KEY (addressee_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: friendships friendships_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.friendships
    ADD CONSTRAINT friendships_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: groups groups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: messages messages_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: notes notes_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: notifications notifications_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.broadcasts(id) ON DELETE CASCADE;

--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: session_shared_tasks session_shared_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

--
-- Name: session_shared_tasks session_shared_tasks_shared_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_shared_tasks
    ADD CONSTRAINT session_shared_tasks_shared_task_id_fkey FOREIGN KEY (shared_task_id) REFERENCES public.shared_session_tasks(id) ON DELETE CASCADE;

--
-- Name: session_tasks session_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

--
-- Name: session_tasks session_tasks_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_tasks
    ADD CONSTRAINT session_tasks_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: sessions sessions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id);

--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- Name: shared_session_events shared_session_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_events shared_session_events_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_events shared_session_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.shared_session_tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_events shared_session_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events
    ADD CONSTRAINT shared_session_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_current_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_current_task_id_fkey FOREIGN KEY (current_task_id) REFERENCES public.shared_session_tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_members shared_session_members_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_members shared_session_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_members
    ADD CONSTRAINT shared_session_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: shared_session_tasks shared_session_tasks_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_tasks shared_session_tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_tasks shared_session_tasks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

--
-- Name: shared_session_tasks shared_session_tasks_source_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_source_task_id_fkey FOREIGN KEY (source_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;

--
-- Name: shared_session_time shared_session_time_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.shared_session_tasks(id) ON DELETE CASCADE;

--
-- Name: shared_session_time shared_session_time_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_time
    ADD CONSTRAINT shared_session_time_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: shared_sessions shared_sessions_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_sessions
    ADD CONSTRAINT shared_sessions_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: task_groups task_groups_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;

--
-- Name: task_groups task_groups_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_groups
    ADD CONSTRAINT task_groups_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: task_shares task_shares_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: task_shares task_shares_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;

--
-- Name: task_shares task_shares_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_shares
    ADD CONSTRAINT task_shares_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: tasks tasks_repeat_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_repeat_from_id_fkey FOREIGN KEY (repeat_from_id) REFERENCES public.tasks(id) ON DELETE SET NULL;

--
-- Name: tasks tasks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);

--
-- PostgreSQL database dump complete
--

