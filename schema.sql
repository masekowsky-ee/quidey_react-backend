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
    CONSTRAINT admin_actions_action_check CHECK ((action = ANY (ARRAY['grant_pro'::text, 'revoke_pro'::text, 'grant_admin'::text, 'revoke_admin'::text, 'grant_tester'::text, 'revoke_tester'::text, 'approve_request'::text, 'decline_request'::text, 'reset_request'::text, 'remove_avatar'::text, 'export_users'::text])))
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
-- Name: challenge_completions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.challenge_completions (
    user_id integer NOT NULL,
    challenge text NOT NULL,
    period date NOT NULL,
    xp integer NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT challenge_completions_challenge_check CHECK ((length(challenge) <= 40)),
    CONSTRAINT challenge_completions_xp_check CHECK (((xp > 0) AND (xp <= 10000)))
);

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
-- Name: event_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_types (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    color text,
    "position" integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT event_types_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT event_types_keywords_check CHECK ((cardinality(keywords) <= 20)),
    CONSTRAINT event_types_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 40)))
);

--
-- Name: event_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.event_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: event_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.event_types_id_seq OWNED BY public.event_types.id;

--
-- Name: families; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.families (
    id integer NOT NULL,
    name text NOT NULL,
    owner_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    note_updated_at timestamp with time zone,
    note_updated_by integer,
    emoji text,
    color text,
    CONSTRAINT families_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT families_emoji_check CHECK (((emoji IS NULL) OR (char_length(emoji) <= 16))),
    CONSTRAINT families_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 60))),
    CONSTRAINT families_note_check CHECK (((note IS NULL) OR (char_length(note) <= 2000)))
);

--
-- Name: families_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.families_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: families_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.families_id_seq OWNED BY public.families.id;

--
-- Name: family_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_groups (
    id integer NOT NULL,
    family_id integer NOT NULL,
    name text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_groups_name_check CHECK (((length(name) >= 1) AND (length(name) <= 40)))
);

--
-- Name: family_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.family_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: family_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.family_groups_id_seq OWNED BY public.family_groups.id;

--
-- Name: family_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_members (
    family_id integer NOT NULL,
    user_id integer NOT NULL,
    status text NOT NULL,
    invited_by integer,
    invited_at timestamp with time zone DEFAULT now() NOT NULL,
    joined_at timestamp with time zone,
    CONSTRAINT family_members_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'joined'::text])))
);

--
-- Name: family_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_messages (
    id integer NOT NULL,
    family_id integer NOT NULL,
    user_id integer NOT NULL,
    text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT family_messages_text_check CHECK (((char_length(text) >= 1) AND (char_length(text) <= 1000)))
);

--
-- Name: family_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.family_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: family_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.family_messages_id_seq OWNED BY public.family_messages.id;

--
-- Name: family_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.family_tasks (
    id integer NOT NULL,
    family_id integer NOT NULL,
    name text NOT NULL,
    description text,
    done boolean DEFAULT false NOT NULL,
    due date,
    due_time time without time zone,
    prio integer,
    duration_minutes integer,
    location text,
    link text,
    details text,
    color text,
    added_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    assignee_id integer,
    group_id integer,
    CONSTRAINT family_tasks_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT family_tasks_due_time_needs_due_check CHECK (((due_time IS NULL) OR (due IS NOT NULL))),
    CONSTRAINT family_tasks_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes >= 1) AND (duration_minutes <= 10080))))
);

--
-- Name: family_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.family_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: family_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.family_tasks_id_seq OWNED BY public.family_tasks.id;

--
-- Name: feed_cheers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feed_cheers (
    event_id integer NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: feed_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feed_events (
    id integer NOT NULL,
    user_id integer NOT NULL,
    kind text NOT NULL,
    day date,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT feed_events_day_needs_day_check CHECK (((kind <> ALL (ARRAY['day'::text, 'streak'::text])) OR (day IS NOT NULL))),
    CONSTRAINT feed_events_kind_check CHECK ((kind = ANY (ARRAY['day'::text, 'challenge'::text, 'level'::text, 'streak'::text, 'post'::text])))
);

--
-- Name: feed_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feed_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: feed_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feed_events_id_seq OWNED BY public.feed_events.id;

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
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    endpoint text NOT NULL,
    p256dh text,
    auth text,
    plan boolean DEFAULT true NOT NULL,
    digest boolean DEFAULT true NOT NULL,
    messages boolean DEFAULT true NOT NULL,
    social boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT push_subscriptions_endpoint_check CHECK (((char_length(endpoint) <= 1000) AND ((endpoint ~ '^https://'::text) OR (endpoint ~ '^fcm:[A-Za-z0-9_:-]+$'::text)))),
    CONSTRAINT push_subscriptions_keys_check CHECK (
CASE
    WHEN (endpoint ~ '^fcm:'::text) THEN ((p256dh IS NULL) AND (auth IS NULL))
    ELSE (((char_length(p256dh) >= 1) AND (char_length(p256dh) <= 200)) AND ((char_length(auth) >= 1) AND (char_length(auth) <= 100)))
END)
);

--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.push_subscriptions_id_seq OWNED BY public.push_subscriptions.id;

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
-- Name: shared_session_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_session_groups (
    id integer NOT NULL,
    session_id integer NOT NULL,
    name text NOT NULL,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT shared_session_groups_name_check CHECK (((length(name) >= 1) AND (length(name) <= 40)))
);

--
-- Name: shared_session_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_session_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: shared_session_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_session_groups_id_seq OWNED BY public.shared_session_groups.id;

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
    kind text DEFAULT 'task'::text NOT NULL,
    group_id integer,
    CONSTRAINT shared_session_tasks_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT shared_session_tasks_due_time_needs_due_check CHECK (((due_time IS NULL) OR (due IS NOT NULL))),
    CONSTRAINT shared_session_tasks_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes >= 1) AND (duration_minutes <= 10080)))),
    CONSTRAINT shared_session_tasks_event_needs_due_check CHECK (((kind <> 'event'::text) OR (due IS NOT NULL))),
    CONSTRAINT shared_session_tasks_kind_check CHECK ((kind = ANY (ARRAY['task'::text, 'event'::text]))),
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
-- Name: shared_time_days; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_time_days (
    user_id integer NOT NULL,
    day date NOT NULL,
    time_ms bigint DEFAULT 0 NOT NULL,
    CONSTRAINT shared_time_days_time_ms_check CHECK ((time_ms >= 0))
);

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
    location text,
    link text,
    details text,
    repeat text,
    repeat_from_id integer,
    completed_at timestamp with time zone,
    color text,
    reminder_email boolean DEFAULT false NOT NULL,
    reminder_mailed_at timestamp with time zone,
    kind text DEFAULT 'task'::text NOT NULL,
    event_type_id integer,
    repeat_left integer,
    repeat_skip date[] DEFAULT '{}'::date[] NOT NULL,
    push_sent_for timestamp with time zone,
    reminders integer[] DEFAULT '{}'::integer[] NOT NULL,
    CONSTRAINT tasks_color_check CHECK (((color IS NULL) OR (color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT tasks_due_time_needs_due_check CHECK (((due_time IS NULL) OR (due IS NOT NULL))),
    CONSTRAINT tasks_duration_minutes_check CHECK (((duration_minutes IS NULL) OR ((duration_minutes >= 1) AND (duration_minutes <= 10080)))),
    CONSTRAINT tasks_event_needs_due_check CHECK (((kind <> 'event'::text) OR (due IS NOT NULL))),
    CONSTRAINT tasks_kind_check CHECK ((kind = ANY (ARRAY['task'::text, 'event'::text]))),
    CONSTRAINT tasks_reminders_check CHECK (((cardinality(reminders) <= 5) AND (array_position(reminders, NULL::integer) IS NULL) AND (0 <= ALL (reminders)) AND (10080 >= ALL (reminders)))),
    CONSTRAINT tasks_repeat_check CHECK (((repeat IS NULL) OR (repeat = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text, 'yearly'::text])))),
    CONSTRAINT tasks_repeat_left_check CHECK (((repeat_left IS NULL) OR ((repeat_left >= 0) AND (repeat_left <= 1000)))),
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
-- Name: tester_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tester_feedback (
    user_id integer NOT NULL,
    topic text NOT NULL,
    rating smallint,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tester_feedback_comment_check CHECK (((comment IS NULL) OR (char_length(comment) <= 2000))),
    CONSTRAINT tester_feedback_rating_check CHECK (((rating IS NULL) OR ((rating >= 1) AND (rating <= 5)))),
    CONSTRAINT tester_feedback_something_check CHECK (((rating IS NOT NULL) OR (comment IS NOT NULL))),
    CONSTRAINT tester_feedback_topic_check CHECK ((topic ~ '^[a-z0-9]+:[a-z0-9-]{1,48}$'::text))
);

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
    level integer DEFAULT 1 NOT NULL,
    avatar_frame text,
    profile_title text,
    showcase_badges text[] DEFAULT '{}'::text[] NOT NULL,
    share_activity boolean DEFAULT true NOT NULL,
    show_online boolean DEFAULT true NOT NULL,
    push_digest_on date,
    allday_reminder_time time without time zone DEFAULT '12:00:00'::time without time zone NOT NULL,
    tour_seen_at timestamp with time zone,
    google_sub text,
    has_password boolean DEFAULT true NOT NULL,
    CONSTRAINT users_avatar_emoji_check CHECK (((avatar_emoji IS NULL) OR (length(avatar_emoji) <= 16))),
    CONSTRAINT users_avatar_frame_check CHECK (((avatar_frame IS NULL) OR (avatar_frame = ANY (ARRAY['ring'::text, 'double'::text, 'dotted'::text, 'orbit'::text])))),
    CONSTRAINT users_banner_check CHECK (((banner IS NULL) OR (banner = ANY (ARRAY['gradient'::text, 'aurora'::text, 'dots'::text, 'stripes'::text, 'grid'::text, 'glow'::text, 'rings'::text, 'topo'::text, 'sky'::text])))),
    CONSTRAINT users_bio_check CHECK (((bio IS NULL) OR (length(bio) <= 280))),
    CONSTRAINT users_interests_check CHECK ((cardinality(interests) <= 6)),
    CONSTRAINT users_language_check CHECK (((language IS NULL) OR (language = ANY (ARRAY['de'::text, 'en'::text])))),
    CONSTRAINT users_level_check CHECK (((level >= 1) AND (level <= 1000))),
    CONSTRAINT users_profile_color_check CHECK (((profile_color IS NULL) OR (profile_color = ANY (ARRAY['red'::text, 'orange'::text, 'yellow'::text, 'green'::text, 'teal'::text, 'blue'::text, 'violet'::text, 'pink'::text])))),
    CONSTRAINT users_profile_title_check CHECK (((profile_title IS NULL) OR (length(profile_title) <= 24))),
    CONSTRAINT users_showcase_badges_check CHECK ((cardinality(showcase_badges) <= 3)),
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
-- Name: event_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_types ALTER COLUMN id SET DEFAULT nextval('public.event_types_id_seq'::regclass);

--
-- Name: families id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families ALTER COLUMN id SET DEFAULT nextval('public.families_id_seq'::regclass);

--
-- Name: family_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups ALTER COLUMN id SET DEFAULT nextval('public.family_groups_id_seq'::regclass);

--
-- Name: family_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_messages ALTER COLUMN id SET DEFAULT nextval('public.family_messages_id_seq'::regclass);

--
-- Name: family_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks ALTER COLUMN id SET DEFAULT nextval('public.family_tasks_id_seq'::regclass);

--
-- Name: feed_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_events ALTER COLUMN id SET DEFAULT nextval('public.feed_events_id_seq'::regclass);

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
-- Name: push_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.push_subscriptions_id_seq'::regclass);

--
-- Name: sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

--
-- Name: shared_session_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_events ALTER COLUMN id SET DEFAULT nextval('public.shared_session_events_id_seq'::regclass);

--
-- Name: shared_session_groups id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_groups ALTER COLUMN id SET DEFAULT nextval('public.shared_session_groups_id_seq'::regclass);

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
-- Name: challenge_completions challenge_completions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_completions
    ADD CONSTRAINT challenge_completions_pkey PRIMARY KEY (user_id, challenge, period);

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
-- Name: event_types event_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_types
    ADD CONSTRAINT event_types_pkey PRIMARY KEY (id);

--
-- Name: families families_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_pkey PRIMARY KEY (id);

--
-- Name: family_groups family_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups
    ADD CONSTRAINT family_groups_pkey PRIMARY KEY (id);

--
-- Name: family_members family_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_pkey PRIMARY KEY (family_id, user_id);

--
-- Name: family_messages family_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_messages
    ADD CONSTRAINT family_messages_pkey PRIMARY KEY (id);

--
-- Name: family_tasks family_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks
    ADD CONSTRAINT family_tasks_pkey PRIMARY KEY (id);

--
-- Name: feed_cheers feed_cheers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_cheers
    ADD CONSTRAINT feed_cheers_pkey PRIMARY KEY (event_id, user_id);

--
-- Name: feed_events feed_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_events
    ADD CONSTRAINT feed_events_pkey PRIMARY KEY (id);

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
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

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
-- Name: shared_session_groups shared_session_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_groups
    ADD CONSTRAINT shared_session_groups_pkey PRIMARY KEY (id);

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
-- Name: shared_time_days shared_time_days_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_time_days
    ADD CONSTRAINT shared_time_days_pkey PRIMARY KEY (user_id, day);

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
-- Name: tester_feedback tester_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tester_feedback
    ADD CONSTRAINT tester_feedback_pkey PRIMARY KEY (user_id, topic);

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
-- Name: event_types_user_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX event_types_user_name_idx ON public.event_types USING btree (user_id, lower(name));

--
-- Name: family_members_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_members_user_idx ON public.family_members USING btree (user_id);

--
-- Name: family_messages_family_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_messages_family_idx ON public.family_messages USING btree (family_id, id);

--
-- Name: family_groups_family_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_groups_family_id_idx ON public.family_groups USING btree (family_id);

--
-- Name: family_tasks_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_tasks_assignee_idx ON public.family_tasks USING btree (assignee_id) WHERE (assignee_id IS NOT NULL);

--
-- Name: family_tasks_family_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_tasks_family_idx ON public.family_tasks USING btree (family_id);

--
-- Name: family_tasks_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX family_tasks_group_id_idx ON public.family_tasks USING btree (group_id) WHERE (group_id IS NOT NULL);

--
-- Name: feed_cheers_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feed_cheers_user_created ON public.feed_cheers USING btree (user_id, created_at);

--
-- Name: feed_events_one_per_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX feed_events_one_per_day ON public.feed_events USING btree (user_id, kind, day) WHERE (kind = ANY (ARRAY['day'::text, 'streak'::text]));

--
-- Name: feed_events_user_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX feed_events_user_updated ON public.feed_events USING btree (user_id, updated_at DESC);

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
-- Name: push_subscriptions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX push_subscriptions_user_idx ON public.push_subscriptions USING btree (user_id);

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
-- Name: shared_session_tasks_open_events_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_tasks_open_events_idx ON public.shared_session_tasks USING btree (due) WHERE ((kind = 'event'::text) AND (NOT done));

--
-- Name: shared_session_groups_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_groups_session_id_idx ON public.shared_session_groups USING btree (session_id);

--
-- Name: shared_session_tasks_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shared_session_tasks_group_id_idx ON public.shared_session_tasks USING btree (group_id) WHERE (group_id IS NOT NULL);

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
-- Name: tasks_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_event_type_idx ON public.tasks USING btree (event_type_id) WHERE (event_type_id IS NOT NULL);

--
-- Name: tasks_open_events_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_open_events_idx ON public.tasks USING btree (due) WHERE ((kind = 'event'::text) AND (NOT done));

--
-- Name: tasks_reminder_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_reminder_email_idx ON public.tasks USING btree (due) WHERE (reminder_email AND (NOT done));

--
-- Name: tasks_repeat_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_repeat_from_idx ON public.tasks USING btree (repeat_from_id);

--
-- Name: tasks_user_events_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_user_events_idx ON public.tasks USING btree (user_id, due) WHERE (kind = 'event'::text);

--
-- Name: tasks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tasks_user_idx ON public.tasks USING btree (user_id);

--
-- Name: tester_feedback_topic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tester_feedback_topic_idx ON public.tester_feedback USING btree (topic);

--
-- Name: users_email_lower_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_lower_unique ON public.users USING btree (lower(email));


--
-- Name: users_google_sub_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_google_sub_key ON public.users USING btree (google_sub);

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
-- Name: challenge_completions challenge_completions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.challenge_completions
    ADD CONSTRAINT challenge_completions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: email_verification_tokens email_verification_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_verification_tokens
    ADD CONSTRAINT email_verification_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: event_types event_types_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_types
    ADD CONSTRAINT event_types_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: families families_note_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_note_updated_by_fkey FOREIGN KEY (note_updated_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: families families_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.families
    ADD CONSTRAINT families_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: family_groups family_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups
    ADD CONSTRAINT family_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: family_groups family_groups_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_groups
    ADD CONSTRAINT family_groups_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;

--
-- Name: family_members family_members_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;

--
-- Name: family_members family_members_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: family_members family_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_members
    ADD CONSTRAINT family_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: family_messages family_messages_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_messages
    ADD CONSTRAINT family_messages_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;

--
-- Name: family_messages family_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_messages
    ADD CONSTRAINT family_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: family_tasks family_tasks_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks
    ADD CONSTRAINT family_tasks_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: family_tasks family_tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks
    ADD CONSTRAINT family_tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: family_tasks family_tasks_family_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks
    ADD CONSTRAINT family_tasks_family_id_fkey FOREIGN KEY (family_id) REFERENCES public.families(id) ON DELETE CASCADE;

--
-- Name: family_tasks family_tasks_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.family_tasks
    ADD CONSTRAINT family_tasks_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.family_groups(id) ON DELETE SET NULL;

--
-- Name: feed_cheers feed_cheers_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_cheers
    ADD CONSTRAINT feed_cheers_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.feed_events(id) ON DELETE CASCADE;

--
-- Name: feed_cheers feed_cheers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_cheers
    ADD CONSTRAINT feed_cheers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- Name: feed_events feed_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feed_events
    ADD CONSTRAINT feed_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

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
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

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
-- Name: shared_session_groups shared_session_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_groups
    ADD CONSTRAINT shared_session_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

--
-- Name: shared_session_groups shared_session_groups_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_groups
    ADD CONSTRAINT shared_session_groups_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.shared_sessions(id) ON DELETE CASCADE;

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
-- Name: shared_session_tasks shared_session_tasks_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_session_tasks
    ADD CONSTRAINT shared_session_tasks_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.shared_session_groups(id) ON DELETE SET NULL;

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
-- Name: shared_time_days shared_time_days_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_time_days
    ADD CONSTRAINT shared_time_days_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

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
-- Name: tasks tasks_event_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_event_type_id_fkey FOREIGN KEY (event_type_id) REFERENCES public.event_types(id) ON DELETE SET NULL;

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
-- Name: tester_feedback tester_feedback_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tester_feedback
    ADD CONSTRAINT tester_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

--
-- 032: the Fokusraum's alarm, routines and the notebook (see migrations/032_focus_routines_notebook.sql)
--

CREATE TABLE IF NOT EXISTS public.focus_alarms (
    user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    fire_at timestamp with time zone NOT NULL,
    phase text NOT NULL CHECK (phase IN ('timer', 'focus', 'short', 'long'))
);
CREATE INDEX IF NOT EXISTS focus_alarms_fire_at ON public.focus_alarms (fire_at);

CREATE TABLE IF NOT EXISTS public.routines (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL,
    emoji text,
    steps jsonb NOT NULL DEFAULT '[]'::jsonb,
    days smallint[] NOT NULL DEFAULT '{}'::smallint[],
    at_time time without time zone,
    remind boolean NOT NULL DEFAULT true,
    reminded_on date,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routines_user_id ON public.routines (user_id);

CREATE TABLE IF NOT EXISTS public.routine_runs (
    id serial PRIMARY KEY,
    routine_id integer NOT NULL REFERENCES public.routines(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL DEFAULT now(),
    steps_done smallint NOT NULL,
    steps_total smallint NOT NULL,
    seconds integer NOT NULL
);
CREATE INDEX IF NOT EXISTS routine_runs_user_finished ON public.routine_runs (user_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS public.notebook_notes (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    task_id integer REFERENCES public.tasks(id) ON DELETE SET NULL,
    title text NOT NULL DEFAULT '',
    body text NOT NULL DEFAULT '',
    pinned boolean NOT NULL DEFAULT false,
    attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notebook_notes_user_updated ON public.notebook_notes (user_id, updated_at DESC);

--
-- 033: profile pictures (see migrations/033_profile_pictures.sql)
--

CREATE TABLE IF NOT EXISTS public.user_avatars (
    user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    image bytea NOT NULL,
    mime text NOT NULL CHECK (mime IN ('image/webp', 'image/jpeg', 'image/png')),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);

--
-- 035: Quidey Pro subscriptions (see migrations/035_pro_subscriptions.sql)
--

CREATE TABLE IF NOT EXISTS public.subscriptions (
    id serial PRIMARY KEY,
    user_id integer REFERENCES public.users(id) ON DELETE SET NULL,
    provider text NOT NULL,
    provider_id text NOT NULL,
    plan text NOT NULL,
    status text NOT NULL,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_provider_check CHECK (provider IN ('stripe', 'play')),
    CONSTRAINT subscriptions_plan_check CHECK (plan IN ('monthly', 'yearly')),
    CONSTRAINT subscriptions_provider_id_check CHECK (char_length(provider_id) BETWEEN 1 AND 1000),
    CONSTRAINT subscriptions_status_check CHECK (char_length(status) BETWEEN 1 AND 40),
    CONSTRAINT subscriptions_provider_key UNIQUE (provider, provider_id)
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON public.subscriptions USING btree (user_id);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pro_until timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_stripe_customer_key ON public.users USING btree (stripe_customer_id);

--
-- 036: the notes area and collections (see migrations/036_notes_collections.sql)
--

CREATE TABLE IF NOT EXISTS public.note_folders (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
    emoji text,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS note_folders_user_name ON public.note_folders (user_id, lower(name));

ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS folder_id integer REFERENCES public.note_folders(id) ON DELETE SET NULL;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE public.notebook_notes ADD COLUMN IF NOT EXISTS trashed_at timestamp with time zone;
CREATE INDEX IF NOT EXISTS notebook_notes_trashed ON public.notebook_notes (trashed_at) WHERE trashed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.collections (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    emoji text,
    color text,
    description text NOT NULL DEFAULT '',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS collections_user ON public.collections (user_id);

CREATE TABLE IF NOT EXISTS public.collection_items (
    id serial PRIMARY KEY,
    collection_id integer NOT NULL REFERENCES public.collections(id) ON DELETE CASCADE,
    task_id integer REFERENCES public.tasks(id) ON DELETE CASCADE,
    note_id integer REFERENCES public.notebook_notes(id) ON DELETE CASCADE,
    added_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT collection_items_one_thing CHECK ((task_id IS NULL) <> (note_id IS NULL)),
    CONSTRAINT collection_items_task_once UNIQUE (collection_id, task_id),
    CONSTRAINT collection_items_note_once UNIQUE (collection_id, note_id)
);
CREATE INDEX IF NOT EXISTS collection_items_task ON public.collection_items (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS collection_items_note ON public.collection_items (note_id) WHERE note_id IS NOT NULL;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS groups_imported_at timestamp with time zone;

--
-- 037: notes pinned to a family's or shared session's board (see migrations/037_board_notes.sql)
--

CREATE TABLE IF NOT EXISTS public.board_notes (
    id serial PRIMARY KEY,
    note_id integer NOT NULL REFERENCES public.notebook_notes(id) ON DELETE CASCADE,
    family_id integer REFERENCES public.families(id) ON DELETE CASCADE,
    session_id integer REFERENCES public.shared_sessions(id) ON DELETE CASCADE,
    pinned_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT board_notes_one_board CHECK ((family_id IS NULL) <> (session_id IS NULL)),
    CONSTRAINT board_notes_family_once UNIQUE (family_id, note_id),
    CONSTRAINT board_notes_session_once UNIQUE (session_id, note_id)
);
CREATE INDEX IF NOT EXISTS board_notes_note ON public.board_notes (note_id);

--
-- 038: the arcade's scores (see migrations/038_arcade_scores.sql)
--

CREATE TABLE IF NOT EXISTS public.arcade_scores (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    game text NOT NULL CHECK (char_length(game) BETWEEN 1 AND 20),
    level text NOT NULL CHECK (level IN ('easy', 'normal', 'hard')),
    best integer NOT NULL DEFAULT 0 CHECK (best >= 0),
    ranked_best integer CHECK (ranked_best >= 0),
    ranked_at timestamp with time zone,
    plays integer NOT NULL DEFAULT 0,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, game, level)
);
CREATE INDEX IF NOT EXISTS arcade_scores_board ON public.arcade_scores (game, level, ranked_best DESC, ranked_at)
    WHERE ranked_best IS NOT NULL;

--
-- 039: reminders (see migrations/039_reminders.sql)
--

CREATE TABLE IF NOT EXISTS public.reminders (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
    at timestamp with time zone,
    days smallint[],
    at_time time without time zone,
    snoozed_until timestamp with time zone,
    done_at timestamp with time zone,
    fired_for timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT reminders_once_or_weekly CHECK (
        (at IS NOT NULL AND days IS NULL AND at_time IS NULL)
        OR (at IS NULL AND at_time IS NOT NULL AND cardinality(days) BETWEEN 1 AND 7)
    )
);
CREATE INDEX IF NOT EXISTS reminders_user ON public.reminders (user_id);
CREATE INDEX IF NOT EXISTS reminders_open ON public.reminders (user_id) WHERE done_at IS NULL;

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS alarms boolean NOT NULL DEFAULT false;

--
-- 040: family events and reminders, done_by, push kind groups (see migrations/040_family_events_groups_push.sql)
--

ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task';
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS reminders integer[] NOT NULL DEFAULT '{}';
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS push_sent_for timestamp with time zone;
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS done_by integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.family_tasks ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_kind_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_kind_check CHECK (kind IN ('task', 'event'));
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_event_needs_due_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_event_needs_due_check CHECK (kind <> 'event' OR due IS NOT NULL);
ALTER TABLE public.family_tasks DROP CONSTRAINT IF EXISTS family_tasks_reminders_check;
ALTER TABLE public.family_tasks ADD CONSTRAINT family_tasks_reminders_check
    CHECK (cardinality(reminders) <= 5 AND array_position(reminders, NULL) IS NULL
        AND 0 <= ALL (reminders) AND 10080 >= ALL (reminders));

ALTER TABLE public.shared_session_tasks ADD COLUMN IF NOT EXISTS done_by integer REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.shared_session_tasks ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS groups boolean NOT NULL DEFAULT true;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check
    CHECK (kind IN ('broadcast', 'system', 'task_assigned', 'entries_added'));

CREATE INDEX IF NOT EXISTS family_tasks_open_events ON public.family_tasks (due) WHERE kind = 'event' AND NOT done;
CREATE INDEX IF NOT EXISTS family_tasks_done_by ON public.family_tasks (done_by, completed_at);
CREATE INDEX IF NOT EXISTS shared_session_tasks_done_by ON public.shared_session_tasks (done_by, completed_at);

--
-- 041: study goals (see migrations/041_study_goals.sql)
--

CREATE TABLE IF NOT EXISTS public.subjects (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    emoji text,
    color text,
    archived boolean NOT NULL DEFAULT false,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT subjects_color_check
        CHECK (color IS NULL OR color IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink'))
);
CREATE UNIQUE INDEX IF NOT EXISTS subjects_user_name ON public.subjects (user_id, lower(name));

CREATE TABLE IF NOT EXISTS public.goals (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    subject_id integer NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
    kind text NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    due date NOT NULL,
    due_time time without time zone,
    plan_mode text NOT NULL DEFAULT 'slots',
    status text NOT NULL DEFAULT 'active',
    behind_notified_minutes integer NOT NULL DEFAULT 0,
    behind_notified_on date,
    freed_minutes integer NOT NULL DEFAULT 0,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT goals_kind_check CHECK (kind IN ('exam', 'assignment', 'presentation', 'other')),
    CONSTRAINT goals_plan_mode_check CHECK (plan_mode IN ('slots', 'days')),
    CONSTRAINT goals_status_check CHECK (status IN ('active', 'done', 'archived'))
);
CREATE INDEX IF NOT EXISTS goals_user_status ON public.goals (user_id, status);

CREATE TABLE IF NOT EXISTS public.goal_parts (
    id serial PRIMARY KEY,
    goal_id integer NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    position integer NOT NULL DEFAULT 0,
    estimate_minutes integer NOT NULL,
    estimate_source text NOT NULL DEFAULT 'default',
    role text NOT NULL DEFAULT 'part',
    done_at timestamp with time zone,
    actual_minutes integer,
    CONSTRAINT goal_parts_estimate_check CHECK (estimate_minutes BETWEEN 15 AND 1200),
    CONSTRAINT goal_parts_source_check CHECK (estimate_source IN ('history', 'pages', 'ai', 'default', 'manual')),
    CONSTRAINT goal_parts_role_check CHECK (role IN ('part', 'review'))
);
CREATE INDEX IF NOT EXISTS goal_parts_goal ON public.goal_parts (goal_id);

CREATE TABLE IF NOT EXISTS public.study_windows (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    weekday smallint NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    CONSTRAINT study_windows_weekday_check CHECK (weekday BETWEEN 1 AND 7),
    CONSTRAINT study_windows_time_check CHECK (start_time < end_time)
);
CREATE INDEX IF NOT EXISTS study_windows_user ON public.study_windows (user_id);

ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS goal_part_id integer REFERENCES public.goal_parts(id) ON DELETE SET NULL;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS plan_pinned boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS tasks_goal_part ON public.tasks (goal_part_id) WHERE goal_part_id IS NOT NULL;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_session_minutes integer NOT NULL DEFAULT 45;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_daily_max_minutes integer NOT NULL DEFAULT 180;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS study_ai_auto boolean NOT NULL DEFAULT false;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_study_session_minutes_check;
ALTER TABLE public.users ADD CONSTRAINT users_study_session_minutes_check CHECK (study_session_minutes BETWEEN 15 AND 180);
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_study_daily_max_minutes_check;
ALTER TABLE public.users ADD CONSTRAINT users_study_daily_max_minutes_check CHECK (study_daily_max_minutes BETWEEN 15 AND 720);

ALTER TABLE public.push_subscriptions ADD COLUMN IF NOT EXISTS study boolean NOT NULL DEFAULT true;

-- 042: own colours and a shape per study goal.
-- A colour is still one of the eight names, or now a colour of one's own as "#rrggbb" (picked on
-- the colour wheel in the app). Applies to everything the app lets one colour with the same picker:
-- tasks, groups, event types, the tasks of shared sessions and families, and study subjects.
-- Study goals get an optional shape (shown in the subject's colour), so the goals of one subject
-- can be told apart at a glance.

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['tasks', 'groups', 'event_types', 'shared_session_tasks', 'family_tasks', 'subjects'] LOOP
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', t, t || '_color_check');
        EXECUTE format(
            'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (color IS NULL OR color IN '
            '(''red'', ''orange'', ''yellow'', ''green'', ''teal'', ''blue'', ''violet'', ''pink'') '
            'OR color ~ ''^#[0-9a-f]{6}$'')',
            t, t || '_color_check');
    END LOOP;
END $$;

ALTER TABLE public.goals ADD COLUMN IF NOT EXISTS shape text;
ALTER TABLE public.goals DROP CONSTRAINT IF EXISTS goals_shape_check;
ALTER TABLE public.goals ADD CONSTRAINT goals_shape_check
    CHECK (shape IS NULL OR shape IN ('circle', 'square', 'triangle', 'diamond', 'star', 'hexagon', 'heart'));

--
-- 043: a task's notes live in the notebook (see migrations/043_task_notes_into_notebook.sql):
-- the rows of `notes` moved into notebook_notes (task_id); `notes` stays, empty.
--

INSERT INTO public.notebook_notes (user_id, task_id, title, body, created_at, updated_at)
SELECT tasks.user_id, notes.task_id, '', btrim(notes.content),
       COALESCE(notes.created_at, now()), COALESCE(notes.created_at, now())
FROM public.notes
JOIN public.tasks ON tasks.id = notes.task_id
WHERE tasks.user_id IS NOT NULL AND btrim(COALESCE(notes.content, '')) <> ''
ORDER BY notes.id;

DELETE FROM public.notes;

--
-- 044: usage statistics, only with consent (see migrations/044_usage_statistics.sql)
--

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS usage_consent text CHECK (usage_consent IN ('granted', 'denied')),  -- NULL = not asked yet
  ADD COLUMN IF NOT EXISTS usage_consent_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS usage_consent_version smallint;

-- the only analytics data that stays: totals, no user id
CREATE TABLE IF NOT EXISTS public.usage_hourly (
  hour        timestamp with time zone NOT NULL,   -- UTC, truncated to the hour
  local_hour  smallint    NOT NULL CHECK (local_hour BETWEEN 0 AND 23),   -- in the person's timezone
  weekday     smallint    NOT NULL CHECK (weekday BETWEEN 1 AND 7),       -- ISO, 1 = Monday, local
  metric      text        NOT NULL CHECK (metric ~ '^[a-z0-9_:]{1,48}$'),
  platform    text        NOT NULL CHECK (platform IN ('web', 'pwa', 'android')),
  language    text        NOT NULL CHECK (language IN ('de', 'en')),
  plan        text        NOT NULL CHECK (plan IN ('free', 'tester', 'pro')),
  events      integer     NOT NULL DEFAULT 0,
  people      integer     NOT NULL DEFAULT 0,  -- distinct people in this hour for this row's dimensions
  value_sum   bigint      NOT NULL DEFAULT 0,  -- e.g. focus seconds, active minutes
  PRIMARY KEY (hour, local_hour, weekday, metric, platform, language, plan)
);
CREATE INDEX IF NOT EXISTS usage_hourly_hour_idx ON public.usage_hourly USING btree (hour);

-- short-lived "already counted" marks so people are distinct; deleted when their period is over
CREATE TABLE IF NOT EXISTS public.usage_seen (
  scope     text        NOT NULL CHECK (scope IN ('hour', 'day', 'week')),
  period    timestamp with time zone NOT NULL,   -- start of the hour / local day / ISO week
  metric    text        NOT NULL,   -- '*' = "active at all"
  user_id   integer     NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  PRIMARY KEY (scope, period, metric, user_id)
);
CREATE INDEX IF NOT EXISTS usage_seen_user_idx ON public.usage_seen USING btree (user_id);

-- distinct people per day and week (across all hours), also totals only
CREATE TABLE IF NOT EXISTS public.usage_people (
  scope    text        NOT NULL CHECK (scope IN ('day', 'week')),
  period   date        NOT NULL,
  metric   text        NOT NULL,
  platform text        NOT NULL,
  language text        NOT NULL,
  plan     text        NOT NULL,
  people   integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, period, metric, platform, language, plan)
);

-- 048: daily allowances for the AI features (see migrations/048_daily_quota.sql)
CREATE TABLE IF NOT EXISTS public.daily_quota (
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    day date NOT NULL,
    kind text NOT NULL,
    used integer DEFAULT 0 NOT NULL,
    CONSTRAINT daily_quota_pkey PRIMARY KEY (user_id, day, kind),
    CONSTRAINT daily_quota_kind_check CHECK ((kind = ANY (ARRAY['scan'::text, 'ai_line'::text]))),
    CONSTRAINT daily_quota_used_check CHECK ((used >= 0))
);

--
-- 046: colours of one's own kept for the colour pickers (see migrations/046_saved_colours.sql)
--

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS saved_colors text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_saved_colors_check;
ALTER TABLE public.users ADD CONSTRAINT users_saved_colors_check CHECK ((cardinality(saved_colors) <= 16));

--
-- 047: feature tips seen per account (see migrations/047_feature_tips.sql; a fresh database has no
-- accounts, so the basics marked seen there don't apply here)
--

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tips_seen text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS tips_off boolean DEFAULT false NOT NULL;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_tips_seen_check;
ALTER TABLE public.users ADD CONSTRAINT users_tips_seen_check CHECK ((cardinality(tips_seen) <= 300));

--
-- PostgreSQL database dump complete
--
-- 047: the timetable from WebUntis (see migrations/047_untis.sql)
-- Both go with the account, and disconnecting deletes them.
CREATE TABLE IF NOT EXISTS public.untis_accounts (
    user_id integer NOT NULL PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    mode text NOT NULL,
    server text,
    school text,
    school_label text,
    username text,
    secret text NOT NULL,
    last_sync_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT untis_accounts_mode_check CHECK ((mode = ANY (ARRAY['login'::text, 'ical'::text])))
);

CREATE TABLE IF NOT EXISTS public.untis_lessons (
    id serial PRIMARY KEY,
    user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    external_id text NOT NULL,
    day date NOT NULL,
    start_min integer NOT NULL,
    end_min integer NOT NULL,
    subject text NOT NULL,
    subject_long text DEFAULT ''::text NOT NULL,
    room text DEFAULT ''::text NOT NULL,
    class_name text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'normal'::text NOT NULL,
    info text DEFAULT ''::text NOT NULL,
    CONSTRAINT untis_lessons_status_check CHECK ((status = ANY (ARRAY['normal'::text, 'cancelled'::text, 'irregular'::text]))),
    CONSTRAINT untis_lessons_times_check CHECK (((start_min >= 0) AND (end_min <= 1440) AND (start_min < end_min)))
);

CREATE INDEX IF NOT EXISTS untis_lessons_user_day ON public.untis_lessons (user_id, day);


